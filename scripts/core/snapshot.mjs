// Snapshot — save and restore the original token field values before our
// first state-driven mutation. This is the same pattern ATL uses
// (token.flags.ATL.originals): persist the pre-modification values so that
// when no state matches anymore, we can roll back cleanly to the user's
// configured token (NOT the prototype, since per-token customisation is
// real and meaningful).

import { MODULE_ID } from "../module.mjs";

/** Field paths whose pre-modification values we capture. Only fields the
 *  engine might mutate. Add to this list when expanding what the engine writes. */
const SNAPSHOT_FIELDS = [
  "texture.src",
  "texture.scaleX",
  "texture.scaleY",
  "texture.tint",
  "texture.anchorX",
  "texture.anchorY",
  "alpha",
  "light.dim",
  "light.bright",
  "light.color",
  "light.alpha",
  "light.angle",
  "light.animation.type",
  "light.animation.speed",
  "light.animation.intensity",
  "light.animation.reverse",
];

/** Returns true if a snapshot already exists on this token. */
export function hasSnapshot(tokenDoc) {
  const snap = tokenDoc.getFlag(MODULE_ID, "snapshot");
  return snap && Object.keys(snap).length > 0;
}

/** Save the current values of all SNAPSHOT_FIELDS into the token's flags. */
export async function takeSnapshot(tokenDoc) {
  const snap = {};
  for (const path of SNAPSHOT_FIELDS) {
    const val = foundry.utils.getProperty(tokenDoc, path);
    if (val !== undefined && val !== null) {
      foundry.utils.setProperty(snap, path, val);
    }
  }
  await tokenDoc.setFlag(MODULE_ID, "snapshot", snap);
}

/** Restore the snapshotted values, then drop the snapshot flag. */
export async function restoreSnapshot(tokenDoc) {
  const snap = tokenDoc.getFlag(MODULE_ID, "snapshot");
  if (!snap) return;

  // Build a flat changes object from snapshot.
  const changes = {};
  for (const path of SNAPSHOT_FIELDS) {
    const val = foundry.utils.getProperty(snap, path);
    if (val !== undefined) {
      changes[path] = val;
    }
  }
  if (Object.keys(changes).length) {
    // Mark with our flag so trigger-bus doesn't reentrant-loop.
    await tokenDoc.update(changes, {
      [`${MODULE_ID}.appliedState`]: "_restore",
    });
  }
  await tokenDoc.unsetFlag(MODULE_ID, "snapshot");
}

/** Drop the snapshot without restoring (for forced cleanup or migration). */
export async function dropSnapshot(tokenDoc) {
  if (hasSnapshot(tokenDoc)) {
    await tokenDoc.unsetFlag(MODULE_ID, "snapshot");
  }
}
