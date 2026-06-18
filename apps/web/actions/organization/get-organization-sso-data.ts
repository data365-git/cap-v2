"use server";

import type { Organisation } from "@cap/web-domain";

export async function getOrganizationSSOData(
	_organizationId: Organisation.OrganisationId,
): Promise<never> {
	throw new Error("SSO is not configured on this instance");
}
