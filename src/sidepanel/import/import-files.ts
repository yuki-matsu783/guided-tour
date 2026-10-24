/**
 * サイドパネルでのツアーパッケージの取り込み（`.yaml` 単体・`.zip`）。
 * 入力は選ばれたファイルと依存（IndexedDB・上書きの確認・通知・時刻）。出力はファイルごとの結果。
 * 1つが失敗しても他のファイルの取り込みは続ける。バックグラウンドへはツアー ID とハッシュだけを送る。
 *
 * 処理フロー（1ファイルごと、順番に）:
 * 1. 拡張子を見て、サイズの上限を確かめる（zip は展開の前に圧縮サイズを見る）
 * 2. zip は `unzipPackage` で逐次展開し、最上位の `tour.yaml` を取り出す
 * 3. `validatePackage` でツアー・参照・画像を検証する
 * 4. 同じ ID があれば上書きの確認を出す（検証のあと。承認されなければ取り消し）
 * 5. `computeHash` でハッシュを求め、`saveTour` で保存する（合計容量の上限を超えれば拒否）
 * 6. `CATALOG_CHANGED` を送る（失敗しても結果は成功）
 */
import {
  PACKAGE_LIMITS,
  TOUR_FILE,
  formatBytesLimit,
  unzipPackage,
  validatePackage,
} from '../../core/package/index.ts';
import type { PackageResult } from '../../core/package/index.ts';
import { STORE, TourRecordSchema, requestToPromise, withTx } from '../../shared/db/index.ts';
import { computeHash } from './hash.ts';
import { saveTour } from './save.ts';
import type { ImportDeps, ImportResult, Issue } from './types.ts';

function issue(file: string, path: string, message: string): Issue {
  return { file, line: null, path, message };
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** 検証前の入口。ファイルを読み、検証の結果か、取り込めない理由を返す。 */
async function readPackage(
  file: File,
  deps: ImportDeps,
): Promise<{ result: PackageResult } | { errors: Issue[] }> {
  const name = file.name;
  const lower = name.toLowerCase();
  const isZip = lower.endsWith('.zip');
  if (!isZip && !lower.endsWith('.yaml') && !lower.endsWith('.yml')) {
    return { errors: [issue(name, '', '取り込めるのは .yaml・.yml・.zip のファイルだけです')] };
  }
  const yamlLimit = `${TOUR_FILE} が上限（${formatBytesLimit(PACKAGE_LIMITS.yamlBytes)}）を超えています`;

  if (!isZip) {
    if (file.size > PACKAGE_LIMITS.yamlBytes) {
      return { errors: [issue(name, '', yamlLimit.replace(TOUR_FILE, 'YAML ファイル'))] };
    }
    const text = decodeUtf8(new Uint8Array(await file.arrayBuffer()));
    if (text === null) return { errors: [issue(name, '', 'YAML ファイルを UTF-8 として読めません')] };
    return { result: validatePackage({ fileName: name, yamlText: text, entries: null }) };
  }

  if (file.size > PACKAGE_LIMITS.zipBytes) {
    return {
      errors: [
        issue(name, '', `zip ファイルのサイズが上限（${formatBytesLimit(PACKAGE_LIMITS.zipBytes)}）を超えています。展開はしません`),
      ],
    };
  }
  const unzipped = await unzipPackage(new Uint8Array(await file.arrayBuffer()), name, deps.unzip);
  if (!unzipped.ok) return { errors: unzipped.errors };
  const yamlBytes = unzipped.entries.get(TOUR_FILE);
  if (yamlBytes === undefined) {
    return { errors: [issue(name, TOUR_FILE, `zip の最上位に ${TOUR_FILE} が必要です（サブディレクトリの中は探しません）`)] };
  }
  if (yamlBytes.length > PACKAGE_LIMITS.yamlBytes) {
    return { errors: [issue(`${name}/${TOUR_FILE}`, '', yamlLimit)] };
  }
  const text = decodeUtf8(yamlBytes);
  if (text === null) {
    return { errors: [issue(`${name}/${TOUR_FILE}`, '', `${TOUR_FILE} を UTF-8 として読めません`)] };
  }
  return { result: validatePackage({ fileName: name, yamlText: text, entries: unzipped.entries }) };
}

async function importOne(file: File, deps: ImportDeps, seenIds: Set<string>): Promise<ImportResult> {
  const fileName = file.name;
  const rejected = (errors: Issue[]): ImportResult => ({ status: 'rejected', fileName, errors });

  const read = await readPackage(file, deps);
  if ('errors' in read) return rejected(read.errors);
  if (!read.result.ok) return rejected(read.result.errors);
  const { tour, yamlText, warnings, files } = read.result;

  // 1回の取り込みの中で同じ ID が重なったら、後のものを拒否する
  if (seenIds.has(tour.id)) {
    return rejected([
      issue(fileName, 'id', 'この取り込みの中に、同じ ID のツアーが先にあります。後のファイルは取り込めません'),
    ]);
  }
  seenIds.add(tour.id);

  // 上書きの確認（検証が通ったものだけ）
  const existing: unknown = await withTx(deps.db, STORE.tours, 'readonly', (tx) =>
    requestToPromise(tx.objectStore(STORE.tours).get(tour.id)),
  );
  const imported = TourRecordSchema.pick({ id: true }).safeParse(existing).success;
  const bundled = (await deps.getBundledTourIds()).includes(tour.id);
  if (imported || bundled) {
    const approved = await deps.confirmOverwrite({
      tourId: tour.id,
      existingSource: imported ? 'imported' : 'bundled',
      running: (await deps.getRunningTourId()) === tour.id,
    });
    if (!approved) return { status: 'cancelled', fileName, tourId: tour.id, name: tour.name };
  }

  const hash = await computeHash(yamlText, files);
  const saved = await saveTour(deps.db, { tour, yamlText, fileName, files, hash, importedAt: deps.now() });
  if (!saved.ok) {
    return rejected([
      issue(
        fileName,
        '',
        `取り込み済みツアーの合計容量が上限（${formatBytesLimit(PACKAGE_LIMITS.totalBytes)}）を超えるため、取り込めません。不要なツアーを削除してください`,
      ),
    ]);
  }

  try {
    await deps.notifyCatalogChanged({ tourId: tour.id, hash });
  } catch {
    // 届かなくても取り込みは成功。バックグラウンドは起動時と次の一覧取得で組み立て直す
  }
  return { status: 'imported', fileName, tourId: tour.id, name: tour.name, origins: [...tour.origins], warnings };
}

/** 選ばれたファイルを順に取り込み、ファイルごとの結果を返す。例外は外へ出さず、拒否の結果にする。 */
export async function importFiles(files: File[], deps: ImportDeps): Promise<ImportResult[]> {
  const seenIds = new Set<string>();
  const results: ImportResult[] = [];
  for (const file of files) {
    try {
      results.push(await importOne(file, deps, seenIds));
    } catch {
      results.push({
        status: 'rejected',
        fileName: file.name,
        errors: [issue(file.name, '', '取り込み中に予期しないエラーが起きました。ファイルを確かめて、もう一度お試しください')],
      });
    }
  }
  return results;
}
