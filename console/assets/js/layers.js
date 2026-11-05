/* Overlay layering — which layer Esc closes. Pure (no DOM) so it is testable.
   Order, top first: confirm modal → review popup / drawer. Esc closes only the
   top open layer; a second Esc closes the next one. */
export function escapeTarget({ modalOpen = false, drawerOpen = false } = {}) {
  if (modalOpen) return 'modal';
  if (drawerOpen) return 'drawer';
  return null;
}

/** Drawer variant for a dataset.kind: only the review sheet is a centred popup. */
export const popupKind = (kind) => kind === 'review';
