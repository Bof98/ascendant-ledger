import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { nowIso } from '../domain/time.js';
import type { StagedTransaction } from '../import/parsers/accountHistory.js';

/**
 * Resource and building catalog maintenance.
 *
 * Rules, per the approved specification. Every one of them is a property of the
 * code in this file, so they are listed here rather than scattered:
 *
 *   1. New ids and codes are discovered automatically during import.
 *   2. Observed mappings persist in `*_catalog`.
 *   3. Manual overrides live in `*_overrides`, a separate table.
 *   4. Overrides win on read (enforced by the `*_resolved` views).
 *   5. An import NEVER touches an override table. Nothing in this file writes
 *      to `resource_overrides` or `building_overrides` at all.
 *   6. The raw id/code and the observed name are preserved even once overridden.
 *   7. first_seen / last_seen / observation_count are maintained.
 *   8. An unidentified id renders as "Unknown Resource #123" (view fallback).
 *   9. Nothing is deleted for being absent from a newer export. There is no
 *      DELETE statement in this module.
 *  10. Mappings accumulate across imports.
 *
 * Resetting an override is a DELETE from the override table only, which is why
 * the observed row must be kept intact underneath it.
 */

export interface CatalogObservation {
  resourcesSeen: number;
  resourcesAdded: number;
  buildingsSeen: number;
  buildingsAdded: number;
}

/**
 * Folds a batch of staged transactions into the catalogs.
 *
 * `first_seen_at` and `last_seen_at` track the TRANSACTION time rather than the
 * import time: what matters is when the company first encountered the resource,
 * not when the file happened to be uploaded. Backfilling older history therefore
 * correctly moves `first_seen_at` earlier.
 */
export async function observeCatalogEntries(
  db: Kysely<Database>,
  rows: readonly StagedTransaction[],
  batchId: string,
): Promise<CatalogObservation> {
  const now = nowIso();

  // Collapse the batch first so each distinct entity costs one statement.
  const resources = new Map<number, { first: string; last: string; count: number; name: string | null }>();
  const buildings = new Map<
    string,
    { code: string | null; name: string | null; level: number | null; first: string; last: string; count: number }
  >();

  for (const row of rows) {
    const at = row.occurredAt.iso;

    if (row.details.resourceId !== null) {
      const id = row.details.resourceId;
      const existing = resources.get(id);
      // A market-fill row names its product in the Description ("Apples market
      // order filled"), which is the only place a resource id and a human name
      // co-occur. That inference is recorded with a confidence below 1.
      const inferred = row.productName;
      if (existing) {
        existing.first = at < existing.first ? at : existing.first;
        existing.last = at > existing.last ? at : existing.last;
        existing.count += 1;
        existing.name ??= inferred;
      } else {
        resources.set(id, { first: at, last: at, count: 1, name: inferred });
      }
    }

    if (row.buildingKey) {
      const key = row.buildingKey;
      const existing = buildings.get(key);
      if (existing) {
        existing.first = at < existing.first ? at : existing.first;
        existing.last = at > existing.last ? at : existing.last;
        existing.count += 1;
        existing.name ??= row.details.buildingName;
        existing.code ??= row.details.buildingCode;
        if (row.details.level !== null) {
          existing.level = Math.max(existing.level ?? 0, row.details.level);
        }
      } else {
        buildings.set(key, {
          code: row.details.buildingCode,
          name: row.details.buildingName,
          level: row.details.level,
          first: at,
          last: at,
          count: 1,
        });
      }
    }
  }

  let resourcesAdded = 0;
  let buildingsAdded = 0;

  for (const [resourceId, obs] of resources) {
    const existing = await db
      .selectFrom('resource_catalog')
      .select(['resource_id', 'first_seen_at', 'last_seen_at', 'observation_count', 'observed_name'])
      .where('resource_id', '=', resourceId)
      .executeTakeFirst();

    if (!existing) {
      await db
        .insertInto('resource_catalog')
        .values({
          resource_id: resourceId,
          observed_name: obs.name,
          observed_name_source: obs.name ? 'description_inference' : null,
          observed_name_confidence: obs.name ? 0.8 : null,
          first_seen_at: obs.first,
          last_seen_at: obs.last,
          first_seen_batch_id: batchId,
          observation_count: obs.count,
          created_at: now,
          updated_at: now,
        })
        .execute();
      resourcesAdded += 1;
      continue;
    }

    // Widen the observed window in both directions and accumulate the count.
    // The observed name is only FILLED IN, never replaced: a later export that
    // happens to lack the description must not erase what we already learned.
    await db
      .updateTable('resource_catalog')
      .set({
        first_seen_at: obs.first < existing.first_seen_at ? obs.first : existing.first_seen_at,
        last_seen_at: obs.last > existing.last_seen_at ? obs.last : existing.last_seen_at,
        observation_count: existing.observation_count + obs.count,
        ...(existing.observed_name === null && obs.name !== null
          ? {
              observed_name: obs.name,
              observed_name_source: 'description_inference' as const,
              observed_name_confidence: 0.8,
            }
          : {}),
        updated_at: now,
      })
      .where('resource_id', '=', resourceId)
      .execute();
  }

  for (const [catalogKey, obs] of buildings) {
    const existing = await db
      .selectFrom('building_catalog')
      .select([
        'catalog_key',
        'first_seen_at',
        'last_seen_at',
        'observation_count',
        'observed_name',
        'building_code',
        'last_known_level',
      ])
      .where('catalog_key', '=', catalogKey)
      .executeTakeFirst();

    if (!existing) {
      await db
        .insertInto('building_catalog')
        .values({
          catalog_key: catalogKey,
          building_code: obs.code,
          observed_name: obs.name,
          last_known_level: obs.level,
          first_seen_at: obs.first,
          last_seen_at: obs.last,
          first_seen_batch_id: batchId,
          observation_count: obs.count,
          created_at: now,
          updated_at: now,
        })
        .execute();
      buildingsAdded += 1;
      continue;
    }

    await db
      .updateTable('building_catalog')
      .set({
        first_seen_at: obs.first < existing.first_seen_at ? obs.first : existing.first_seen_at,
        last_seen_at: obs.last > existing.last_seen_at ? obs.last : existing.last_seen_at,
        observation_count: existing.observation_count + obs.count,
        ...(existing.observed_name === null && obs.name !== null ? { observed_name: obs.name } : {}),
        ...(existing.building_code === null && obs.code !== null ? { building_code: obs.code } : {}),
        ...(obs.level !== null && obs.level > (existing.last_known_level ?? -1)
          ? { last_known_level: obs.level }
          : {}),
        updated_at: now,
      })
      .where('catalog_key', '=', catalogKey)
      .execute();
  }

  return {
    resourcesSeen: resources.size,
    resourcesAdded,
    buildingsSeen: buildings.size,
    buildingsAdded,
  };
}

/** Sets or replaces a manual resource override. Never touches the catalog. */
export async function setResourceOverride(
  db: Kysely<Database>,
  resourceId: number,
  displayName: string,
  note: string | null = null,
): Promise<void> {
  const now = nowIso();
  await db
    .insertInto('resource_overrides')
    .values({
      resource_id: resourceId,
      display_name: displayName,
      note,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.column('resource_id').doUpdateSet({ display_name: displayName, note, updated_at: now }),
    )
    .execute();
}

/**
 * Clears a manual override, returning the entry to its observed mapping.
 *
 * Deliberately a delete from the OVERRIDE table only. The observed catalog row
 * survives untouched, which is what makes "reset" mean "fall back to what was
 * observed" rather than "forget this resource".
 */
export async function clearResourceOverride(
  db: Kysely<Database>,
  resourceId: number,
): Promise<void> {
  await db.deleteFrom('resource_overrides').where('resource_id', '=', resourceId).execute();
}

export async function setBuildingOverride(
  db: Kysely<Database>,
  catalogKey: string,
  displayName: string,
  note: string | null = null,
): Promise<void> {
  const now = nowIso();
  await db
    .insertInto('building_overrides')
    .values({
      catalog_key: catalogKey,
      display_name: displayName,
      note,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.column('catalog_key').doUpdateSet({ display_name: displayName, note, updated_at: now }),
    )
    .execute();
}

export async function clearBuildingOverride(
  db: Kysely<Database>,
  catalogKey: string,
): Promise<void> {
  await db.deleteFrom('building_overrides').where('catalog_key', '=', catalogKey).execute();
}
