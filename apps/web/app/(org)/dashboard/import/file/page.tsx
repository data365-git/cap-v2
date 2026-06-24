import type { Metadata } from "next";
import { ImportFilePage } from "./ImportFilePage";

export const metadata: Metadata = {
	title: "Upload File — data365",
};

export default async function Page({
	searchParams,
}: {
	searchParams: Promise<{ folderId?: string; context?: string }>;
}) {
	const { folderId, context: rawContext } = await searchParams;
	const context: "meeting" | "instruction" =
		rawContext === "meeting" ? "meeting" : "instruction";
	return <ImportFilePage folderId={folderId} context={context} />;
}
