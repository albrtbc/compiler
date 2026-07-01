"use strict";

/* Deck ordering. The Protocol card (landscape, kind "protocol") comes first,
   then value cards (kind "compile") by value ascending. Pure comparators,
   shared by the live deck sort and the share/export state sort. */

// 0 = the landscape "Protocol card" (sorts first), 1 = a value card.
export function kindPriority(state) {
  return state.kind === "protocol" ? 0 : 1;
}

const valueOf = (state) => parseFloat(state.value) || 0;

// Comparator over card STATE objects (used for share/export ordering).
export function compareCardStates(a, b) {
  const pa = kindPriority(a), pb = kindPriority(b);
  if (pa !== pb) return pa - pb;
  if (pa === 0) return 0; // protocol cards keep their order
  return valueOf(a) - valueOf(b);
}

// Comparator over deck ENTRIES ({ state, _new }). Freshly-added (_new) cards
// stay pinned at the end until the deck is saved, so a blank card you're
// composing doesn't jump around by value while you type.
export function compareDeckEntries(a, b) {
  const pa = kindPriority(a.state), pb = kindPriority(b.state);
  if (pa !== pb) return pa - pb;
  if (pa === 0) return 0;
  const na = a._new ? 1 : 0, nb = b._new ? 1 : 0;
  if (na !== nb) return na - nb; // new (unsaved) cards last
  if (na === 1) return 0;        // keep insertion order among new cards
  return valueOf(a.state) - valueOf(b.state);
}
