import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@cap/database/auth/session";
import { AccessManagement } from "./AccessManagement";

export const metadata: Metadata = {
	title: "Access Management — Admin",
};

export default async function AdminAccessPage() {
	const user = await getCurrentUser();

	if (!user) {
		redirect("/login");
	}

	if (!user.isAdmin) {
		redirect("/dashboard");
	}

	return <AccessManagement />;
}
