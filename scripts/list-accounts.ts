import { db } from "../packages/database/index.ts";
import { users, videos, organizations, organizationMembers } from "../packages/database/schema.ts";
import { eq, sql, count } from "drizzle-orm";

async function listAccounts() {
  const allUsers = await db()
    .select({
      id: users.id,
      name: users.name,
      lastName: users.lastName,
      email: users.email,
      isAdmin: users.isAdmin,
      activeOrganizationId: users.activeOrganizationId,
      created_at: users.created_at,
    })
    .from(users)
    .orderBy(users.created_at);

  console.log("\n=== ALL USER ACCOUNTS ===\n");

  for (const user of allUsers) {
    const videoCount = await db()
      .select({ count: count() })
      .from(videos)
      .where(eq(videos.ownerId, user.id));

    const orgs = await db()
      .select({
        orgId: organizations.id,
        orgName: organizations.name,
        role: organizationMembers.role,
      })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(eq(organizationMembers.userId, user.id));

    console.log(`User #${allUsers.indexOf(user) + 1}:`);
    console.log(`  ID:       ${user.id}`);
    console.log(`  Email:    ${user.email}`);
    console.log(`  Name:     ${user.name ?? "(none)"} ${user.lastName ?? ""}`);
    console.log(`  Admin:    ${user.isAdmin}`);
    console.log(`  Videos:   ${videoCount[0]?.count ?? 0}`);
    console.log(`  Created:  ${user.created_at}`);
    console.log(`  Orgs:`);
    for (const org of orgs) {
      console.log(`    - ${org.orgName} (${org.orgId}) [${org.role}]`);
    }
    console.log("");
  }

  process.exit(0);
}

listAccounts().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
