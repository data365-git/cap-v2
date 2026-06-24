"use client";

import { Button } from "@cap/ui";
import type { Folder } from "@cap/web-domain";
import { faFolderPlus } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useState } from "react";
import { SubfolderDialog } from "./SubfolderDialog";

interface NewSubfolderButtonProps {
	parentFolderId: Folder.FolderId;
	context?: "meeting" | "instruction";
}

export const NewSubfolderButton = ({
	parentFolderId,
	context,
}: NewSubfolderButtonProps) => {
	const [openDialog, setOpenDialog] = useState(false);

	return (
		<>
			<Button
				onClick={() => setOpenDialog(true)}
				size="sm"
				variant="dark"
				className="flex gap-2 items-center"
			>
				<FontAwesomeIcon className="size-3.5" icon={faFolderPlus} />
				New Subfolder
			</Button>
			<SubfolderDialog
				open={openDialog}
				onOpenChange={setOpenDialog}
				parentFolderId={parentFolderId}
				context={context}
			/>
		</>
	);
};
