/**
 * The asset join resolver contract — turns a package id into the `asset` block every runtime and projection event
 * carries (docs/design/integration-v1.md §2.2). Implemented by the API (`integration/exports/join.ts`,
 * `createJoinResolver`) with a cache the projector invalidates on model events; consumed by the detector.
 *
 * Resolves to null only when the package does not exist. A package without an AAS (or an AAS without a global asset
 * id) still resolves, with `globalAssetId` / `aasId` null, so connection events of such a package can go out.
 */
import type { AssetJoin } from './events.js';

export type AssetJoinResolver = (packageId: string) => Promise<AssetJoin | null>;
