import bcrypt from "bcryptjs";
import { db } from "../packages/database/index.ts";
import { nanoId } from "../packages/database/helpers.ts";
import {
  users,
  organizations,
  organizationMembers,
} from "../packages/database/schema.ts";

async function seedAdmin() {
  const email = process.env.INITIAL_ADMIN_EMAIL;
  const password = process.env.INITIAL_ADMIN_PASSWORD;

  if (!email || !password) {
    console.error(
      "INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD must be set in .env"
    );
    process.exit(1);
  }

  // Check if any users exist
  const existingUsers = await db()
    .select({ id: users.id })
    .from(users)
    .limit(1);

  if (existingUsers.length > 0) {
    console.log("Admin already seeded, skipping");
    process.exit(0);
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const userId = nanoId() as any; // User.UserId branded type
  const organizationId = nanoId() as any; // Organisation.OrganisationId branded type

  // Create the default personal organization first (same pattern as invite.ts)
  await db().insert(organizations).values({
    id: organizationId,
    ownerId: userId,
    name: "Admin's Organization",
  });

  // Create the admin user with the org reference
  await db().insert(users).values({
    id: userId,
    email: email.trim().toLowerCase(),
    name: "Admin",
    passwordHash,
    emailVerified: new Date(),
    activeOrganizationId: organizationId,
    defaultOrgId: organizationId,
    inviteQuota: 1,
    isAdmin: true,
  });

  // Add user as owner of the organization
  await db().insert(organizationMembers).values({
    id: nanoId(),
    userId,
    organizationId,
    role: "owner",
  });

  console.log(`Admin user created: ${email}`);
  process.exit(0);
}

seedAdmin().catch((err) => {
  console.error("Failed to seed admin:", err);
  process.exit(1);
});
