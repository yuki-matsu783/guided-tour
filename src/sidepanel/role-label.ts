/**
 * 役割の ID から表示名を引く。`PanelView.roles` に無い役割（写しに載る前など）は、ID をそのまま返す。
 */
import type { PanelView } from '../shared/messages/index.ts';

export function roleLabelOf(roles: PanelView['roles'], id: string): string {
  return roles.find((r) => r.id === id)?.label ?? id;
}
