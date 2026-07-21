/**
 * Merge account data from a SOURCE user into a TARGET user.
 *
 * Transfers all videos (and their related records) from SOURCE to TARGET.
 * Does NOT delete the source user — only copies/moves ownership.
 *
 * Usage:
 *   railway run pnpm tsx scripts/merge-accounts.ts --source <email> --target <email> [--dry-run]
 *
 * --dry-run   Show what would change without actually modifying the database.
 */

import { db } from "../packages/database/index.ts";
import {
  users,
  videos,
  organizations,
  organizationMembers,
  comments,
  notifications,
  sharedVideos,
  folders,
  spaceVideos,
  transcriptChunks,
  aiUsageEvents,
} from "../packages/database/schema.ts";
import { eq, sql, count, and, inArray } from "drizzle-orm";

function parseArgs() {
  const args = process.argv.slice(2);
  let source = "";
  let target = "";
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--source" && args[i + 1]) {
      source = args[++i].trim().toLowerCase();
    } else if (args[i] === "--target" && args[i + 1]) {
      target = args[++i].trim().toLowerCase();
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    }
  }

  if (!source || !target) {
    console.error("Usage: tsx scripts/merge-accounts.ts --source <email> --target <email> [--dry-run]");
    process.exit(1);
  }

  return { source, target, dryRun };
}

async function main() {
  const { source, target, dryRun } = parseArgs();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`MERGE ACCOUNT DATA`);
  console.log(`Source: ${source}`);
  console.log(`Target: ${target}`);
  console.log(`Mode:   ${dryRun ? "DRY RUN (no changes)" : "LIVE"}`);
  console.log(`${"=".repeat(60)}\n`);

  const [sourceUser] = await db()
    .select()
    .from(users)
    .where(eq(users.email, source));

  if (!sourceUser) {
    console.error(`Source user not found: ${source}`);
    process.exit(1);
  }

  const [targetUser] = await db()
    .select()
    .from(users)
    .where(eq(users.email, target));

  if (!targetUser) {
    console.error(`Target user not found: ${target}`);
    process.exit(1);
  }

  console.log(`Source user: ${sourceUser.email} (ID: ${sourceUser.id}, name: ${sourceUser.name})`);
  console.log(`Target user: ${targetUser.email} (ID: ${targetUser.id}, name: ${targetUser.name})\n`);

  // Find target user's primary organization
  const [targetOrgMembership] = await db()
    .select({
      orgId: organizationMembers.organizationId,
      role: organizationMembers.role,
    })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, targetUser.id))
    .limit(1);

  if (!targetOrgMembership) {
    console.error(`Target user has no organization membership! Cannot proceed.`);
    process.exit(1);
  }

  const targetOrgId = targetOrgMembership.orgId;
  console.log(`Target organization: ${targetOrgId}\n`);

  // Count source videos
  const sourceVideos = await db()
    .select({ id: videos.id, name: videos.name, orgId: videos.orgId })
    .from(videos)
    .where(eq(videos.ownerId, sourceUser.id));

  console.log(`Found ${sourceVideos.length} videos to transfer from source to target.\n`);

  if (sourceVideos.length === 0) {
    console.log("No videos to transfer. Nothing to do.");
    process.exit(0);
  }

  // List the videos being transferred
  for (const v of sourceVideos) {
    console.log(`  - ${v.name} (${v.id})`);
  }
  console.log("");

  const sourceVideoIds = sourceVideos.map((v) => v.id);

  // Count related records
  const [commentCount] = await db()
    .select({ count: count() })
    .from(comments)
    .where(and(
      inArray(comments.videoId, sourceVideoIds),
      eq(comments.authorId, sourceUser.id),
    ));

  const [notifCount] = await db()
    .select({ count: count() })
    .from(notifications)
    .where(eq(notifications.recipientId, sourceUser.id));

  const [sharedCount] = await db()
    .select({ count: count() })
    .from(sharedVideos)
    .where(inArray(sharedVideos.videoId, sourceVideoIds));

  const [spaceVideoCount] = await db()
    .select({ count: count() })
    .from(spaceVideos)
    .where(inArray(spaceVideos.videoId, sourceVideoIds));

  // Count source folders
  const sourceFolders = await db()
    .select({ id: folders.id, name: folders.name })
    .from(folders)
    .where(eq(folders.createdById, sourceUser.id));

  const [aiUsageCount] = await db()
    .select({ count: count() })
    .from(aiUsageEvents)
    .where(eq(aiUsageEvents.userId, sourceUser.id));

  console.log(`Related records:`);
  console.log(`  Comments by source on these videos: ${commentCount?.count ?? 0}`);
  console.log(`  Notifications for source user:      ${notifCount?.count ?? 0}`);
  console.log(`  Shared video records:               ${sharedCount?.count ?? 0}`);
  console.log(`  Space video records:                ${spaceVideoCount?.count ?? 0}`);
  console.log(`  Folders owned by source:            ${sourceFolders.length}`);
  console.log(`  AI usage events:                    ${aiUsageCount?.count ?? 0}`);
  console.log("");

  if (dryRun) {
    console.log("DRY RUN — no changes made. Remove --dry-run to execute.\n");
    process.exit(0);
  }

  // ========== EXECUTE MERGE ==========
  console.log("Starting merge...\n");

  // 1. Transfer videos: update ownerId and orgId
  const videoResult = await db()
    .update(videos)
    .set({
      ownerId: targetUser.id as any,
      orgId: targetOrgId as any,
    })
    .where(eq(videos.ownerId, sourceUser.id));

  console.log(`[1/7] Videos transferred: ${sourceVideos.length} videos -> ownerId=${targetUser.id}, orgId=${targetOrgId}`);

  // 2. Transfer folders: update createdById and orgId
  if (sourceFolders.length > 0) {
    await db()
      .update(folders)
      .set({
        createdById: targetUser.id as any,
        organizationId: targetOrgId as any,
      })
      .where(eq(folders.createdById, sourceUser.id));

    console.log(`[2/7] Folders transferred: ${sourceFolders.length} folders`);
  } else {
    console.log(`[2/7] Folders: none to transfer`);
  }

  // 3. Transfer comments authored by source user on these videos
  if ((commentCount?.count ?? 0) > 0) {
    await db()
      .update(comments)
      .set({ authorId: targetUser.id as any })
      .where(and(
        inArray(comments.videoId, sourceVideoIds),
        eq(comments.authorId, sourceUser.id),
      ));

    console.log(`[3/7] Comments re-attributed: ${commentCount?.count}`);
  } else {
    console.log(`[3/7] Comments: none to transfer`);
  }

  // 4. Transfer shared video records
  if ((sharedCount?.count ?? 0) > 0) {
    await db()
      .update(sharedVideos)
      .set({
        sharedByUserId: targetUser.id as any,
        organizationId: targetOrgId as any,
      })
      .where(and(
        inArray(sharedVideos.videoId, sourceVideoIds),
        eq(sharedVideos.sharedByUserId, sourceUser.id),
      ));

    console.log(`[4/7] Shared video records updated: ${sharedCount?.count}`);
  } else {
    console.log(`[4/7] Shared videos: none to transfer`);
  }

  // 5. Transfer space video records
  if ((spaceVideoCount?.count ?? 0) > 0) {
    await db()
      .update(spaceVideos)
      .set({ addedById: targetUser.id as any })
      .where(and(
        inArray(spaceVideos.videoId, sourceVideoIds),
        eq(spaceVideos.addedById, sourceUser.id),
      ));

    console.log(`[5/7] Space video records updated: ${spaceVideoCount?.count}`);
  } else {
    console.log(`[5/7] Space videos: none to transfer`);
  }

  // 6. Transfer notifications
  if ((notifCount?.count ?? 0) > 0) {
    await db()
      .update(notifications)
      .set({ recipientId: targetUser.id as any })
      .where(eq(notifications.recipientId, sourceUser.id));

    console.log(`[6/7] Notifications transferred: ${notifCount?.count}`);
  } else {
    console.log(`[6/7] Notifications: none to transfer`);
  }

  // 7. Transfer AI usage events
  if ((aiUsageCount?.count ?? 0) > 0) {
    await db()
      .update(aiUsageEvents)
      .set({ userId: targetUser.id as any })
      .where(eq(aiUsageEvents.userId, sourceUser.id));

    console.log(`[7/7] AI usage events transferred: ${aiUsageCount?.count}`);
  } else {
    console.log(`[7/7] AI usage events: none to transfer`);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`MERGE COMPLETE`);
  console.log(`All data from ${source} has been transferred to ${target}.`);
  console.log(`The source account (${source}) still exists but owns no videos.`);
  console.log(`${"=".repeat(60)}\n`);

  process.exit(0);
}

main().catch((err) => {
  console.error("Merge failed:", err);
  process.exit(1);
});
