/**
 * ツアーの内容のハッシュ（SHA-256 の 16 進）。YAML の本文と、保存するファイルのパス・中身から決まる。
 * 同じ内容なら同じ値、1 バイト違えば別の値になる。ファイル名や取り込み時刻は含めない。
 */
import type { Bytes, PackageFile } from '../../core/package/index.ts';

const encoder = new TextEncoder();

async function sha256Hex(data: Bytes): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 各部分のハッシュを順に並べ、そのハッシュを取る（大きなファイルを1つにつながずに済む）。 */
export async function computeHash(yamlText: string, files: readonly PackageFile[]): Promise<string> {
  const lines = [`yaml\0${await sha256Hex(encoder.encode(yamlText))}`];
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    lines.push(`file\0${file.path}\0${await sha256Hex(file.bytes)}`);
  }
  return sha256Hex(encoder.encode(lines.join('\n')));
}
