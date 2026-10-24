/**
 * キーが外から決まる対応表（ツアー ID・役割の名前）を読む道具。
 * `toString`・`constructor` のような名前で `Object.prototype` を拾わないよう、自分のキーだけを読む。
 */
export function ownValue<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  if (record === undefined || !Object.hasOwn(record, key)) return undefined;
  return record[key];
}
