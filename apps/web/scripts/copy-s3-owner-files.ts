/**
 * Copy all S3 objects from one user's prefix to another user's prefix.
 *
 * When a user's videos are re-assigned to a different owner (via merge-accounts.ts),
 * the S3 file paths need to be moved too, because the application reads from
 * `{ownerId}/{videoId}/...`.
 *
 * Usage:
 *   pnpm tsx scripts/copy-s3-owner-files.ts \
 *     --source-user <sourceUserId> \
 *     --target-user <targetUserId> \
 *     [--dry-run] [--delete-source]
 *
 * --dry-run        Show what would be copied without actually copying.
 * --delete-source  After successful copy, delete the source files (default: keep).
 */

import {
  S3Client,
  ListObjectsV2Command,
  CopyObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

function parseArgs() {
  const args = process.argv.slice(2);
  let sourceUser = "";
  let targetUser = "";
  let dryRun = false;
  let deleteSource = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--source-user" && args[i + 1]) {
      sourceUser = args[++i].trim();
    } else if (args[i] === "--target-user" && args[i + 1]) {
      targetUser = args[++i].trim();
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--delete-source") {
      deleteSource = true;
    }
  }

  if (!sourceUser || !targetUser) {
    console.error(
      "Usage: tsx scripts/copy-s3-owner-files.ts --source-user <id> --target-user <id> [--dry-run] [--delete-source]",
    );
    process.exit(1);
  }

  return { sourceUser, targetUser, dryRun, deleteSource };
}

function getBucketConfig() {
  const bucket =
    process.env.CAP_AWS_BUCKET ||
    process.env.CLOUDFLARE_R2_BUCKET ||
    process.env.S3_BUCKET;
  const region = process.env.CAP_AWS_REGION || "auto";
  const accessKeyId =
    process.env.CAP_AWS_ACCESS_KEY ||
    process.env.CLOUDFLARE_R2_ACCESS_KEY ||
    process.env.S3_ACCESS_KEY;
  const secretAccessKey =
    process.env.CAP_AWS_SECRET_KEY ||
    process.env.CLOUDFLARE_R2_SECRET_KEY ||
    process.env.S3_SECRET_KEY;
  const endpoint =
    process.env.CAP_AWS_ENDPOINT || process.env.S3_INTERNAL_ENDPOINT;

  const r2AccountId = process.env.CLOUDFLARE_R2_ACCOUNT_ID;
  const resolvedEndpoint =
    endpoint ||
    (r2AccountId
      ? `https://${r2AccountId}.r2.cloudflarestorage.com`
      : undefined);

  if (!bucket) throw new Error("CAP_AWS_BUCKET (or equivalent) not set");
  if (!accessKeyId) throw new Error("CAP_AWS_ACCESS_KEY (or equivalent) not set");
  if (!secretAccessKey)
    throw new Error("CAP_AWS_SECRET_KEY (or equivalent) not set");

  return {
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    endpoint: resolvedEndpoint,
  };
}

async function main() {
  const { sourceUser, targetUser, dryRun, deleteSource } = parseArgs();
  const cfg = getBucketConfig();

  console.log("\n============================================================");
  console.log("COPY S3 OWNER FILES");
  console.log(`Bucket:       ${cfg.bucket}`);
  console.log(`Endpoint:     ${cfg.endpoint || "(default AWS)"}`);
  console.log(`Source user:  ${sourceUser}`);
  console.log(`Target user:  ${targetUser}`);
  console.log(`Mode:         ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`Delete src:   ${deleteSource ? "YES" : "no (keep source files)"}`);
  console.log("============================================================\n");

  const client = new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    forcePathStyle: !!cfg.endpoint,
  });

  const sourcePrefix = `${sourceUser}/`;
  const targetPrefix = `${targetUser}/`;

  // List all objects under source user prefix
  const allObjects: { Key: string; Size: number }[] = [];
  let continuationToken: string | undefined = undefined;

  do {
    const resp: any = await client.send(
      new ListObjectsV2Command({
        Bucket: cfg.bucket,
        Prefix: sourcePrefix,
        ContinuationToken: continuationToken,
      }),
    );

    if (resp.Contents) {
      for (const obj of resp.Contents) {
        if (obj.Key) {
          allObjects.push({ Key: obj.Key, Size: obj.Size || 0 });
        }
      }
    }

    continuationToken = resp.NextContinuationToken;
  } while (continuationToken);

  console.log(`Found ${allObjects.length} objects under prefix "${sourcePrefix}"`);

  if (allObjects.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const totalBytes = allObjects.reduce((s, o) => s + o.Size, 0);
  console.log(`Total size:  ${(totalBytes / 1024 / 1024).toFixed(2)} MB\n`);

  if (dryRun) {
    console.log("DRY RUN — would copy the following:");
    for (const obj of allObjects.slice(0, 20)) {
      const newKey = targetPrefix + obj.Key.slice(sourcePrefix.length);
      console.log(`  ${obj.Key}\n    -> ${newKey}  (${obj.Size} bytes)`);
    }
    if (allObjects.length > 20) {
      console.log(`  ... and ${allObjects.length - 20} more`);
    }
    console.log("\nDRY RUN complete. Remove --dry-run to execute.");
    return;
  }

  let copied = 0;
  let skipped = 0;
  let deleted = 0;
  let errors = 0;

  for (const obj of allObjects) {
    const newKey = targetPrefix + obj.Key.slice(sourcePrefix.length);

    try {
      // Skip if target already exists
      let targetExists = false;
      try {
        await client.send(
          new HeadObjectCommand({ Bucket: cfg.bucket, Key: newKey }),
        );
        targetExists = true;
      } catch (_e) {
        targetExists = false;
      }

      if (targetExists) {
        console.log(`  [skip] ${newKey} (already exists)`);
        skipped++;
      } else {
        await client.send(
          new CopyObjectCommand({
            Bucket: cfg.bucket,
            CopySource: `${cfg.bucket}/${encodeURIComponent(obj.Key).replace(/%2F/g, "/")}`,
            Key: newKey,
          }),
        );
        console.log(`  [copy] ${obj.Key}`);
        console.log(`      -> ${newKey}`);
        copied++;
      }

      if (deleteSource) {
        await client.send(
          new DeleteObjectCommand({ Bucket: cfg.bucket, Key: obj.Key }),
        );
        deleted++;
      }
    } catch (e: any) {
      console.error(`  [ERROR] ${obj.Key}: ${e.message || e}`);
      errors++;
    }
  }

  console.log("\n============================================================");
  console.log("COPY COMPLETE");
  console.log(`Copied:  ${copied}`);
  console.log(`Skipped: ${skipped} (already at target)`);
  if (deleteSource) console.log(`Deleted: ${deleted}`);
  if (errors > 0) console.log(`Errors:  ${errors}`);
  console.log("============================================================\n");

  if (errors > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
