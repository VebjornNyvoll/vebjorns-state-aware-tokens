// Coexistence — detect when another token-management module is actively
// managing a given token's image, so we can defer instead of clobbering.
//
// The three modules we know about:
//
//   - Token Variants Art  (TVA)         flags."token-variants".defaultImg
//   - Visage              (Filroden)    flags.visage.activeStack
//   - Active Token Lighting (ATL)       flags.ATL.originals
//
// All three set their own snapshot flag BEFORE their first swap, then roll
// back to those values when their conditions clear. If we clobber `texture.src`
// while their snapshot flag is set, their rollback will restore an obsolete
// value — corruption.
//
// Detection runs at the start of every apply cycle.

/** Returns the name of the module currently owning this token's image, or null. */
export function isTokenManagedExternally(tokenDoc) {
  const flags = tokenDoc.flags ?? {};

  // Token Variants Art — sets `defaultImg` on first swap.
  const tva = flags["token-variants"];
  if (tva?.defaultImg && (typeof tva.defaultImg === "object"
                          ? Object.keys(tva.defaultImg).length > 0
                          : tva.defaultImg.length > 0)) {
    return "TokenVariantsArt";
  }

  // Visage — non-empty active stack means actively layered.
  const visage = flags.visage;
  if (Array.isArray(visage?.activeStack) && visage.activeStack.length > 0) {
    return "Visage";
  }
  if (visage?.tokenSnapshot && Object.keys(visage.tokenSnapshot).length > 0) {
    return "Visage";
  }

  // Active Token Lighting — `originals` populated means an AE is active.
  const atl = flags.ATL;
  if (atl?.originals && Object.keys(atl.originals).length > 0) {
    return "ATL";
  }

  return null;
}

/** Check at module-init time whether ANY actors / tokens have external-management
 *  flags. Used by the "warn" coexistence mode. Returns a summary object. */
export function scanForExternalManagement() {
  const summary = {
    TokenVariantsArt: 0,
    Visage:           0,
    ATL:              0,
  };

  // Iterate placed tokens across all loaded scenes.
  for (const scene of game.scenes) {
    for (const tokenDoc of scene.tokens) {
      const owner = isTokenManagedExternally(tokenDoc);
      if (owner) summary[owner] = (summary[owner] ?? 0) + 1;
    }
  }

  return summary;
}
