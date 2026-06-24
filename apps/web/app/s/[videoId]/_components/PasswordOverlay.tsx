"use client";

import { Button, Dialog, DialogContent, Input, Logo } from "@cap/ui";
import type { Video } from "@cap/web-domain";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { verifyVideoPassword } from "@/actions/videos/password";

interface PasswordOverlayProps {
	isOpen: boolean;
	videoId: Video.VideoId;
}

export const PasswordOverlay: React.FC<PasswordOverlayProps> = ({
	isOpen,
	videoId,
}) => {
	const [password, setPassword] = useState("");
	const [errorMsg, setErrorMsg] = useState<string | null>(null);
	const passwordInputRef = useRef<HTMLInputElement>(null);
	const router = useRouter();

	const verifyPassword = useMutation({
		mutationFn: () =>
			verifyVideoPassword(videoId, password).then((v) => {
				if (v.success) return v.value;
				throw new Error(v.error);
			}),
		onSuccess: (result) => {
			setErrorMsg(null);
			toast.success(result);
			router.refresh();
		},
		onError: (e) => {
			setErrorMsg(e.message);
			toast.error(e.message);
			setTimeout(() => passwordInputRef.current?.focus(), 0);
		},
	});

	return (
		<Dialog open={isOpen}>
			<DialogContent className="w-[95vw] max-w-sm p-4 sm:p-6 md:p-8 sm:max-w-md">
				<div className="flex flex-col items-center space-y-4 sm:space-y-6">
					<div className="flex flex-col items-center space-y-3 sm:space-y-4">
						<Logo className="w-16 sm:w-20 md:w-24 h-auto" />
						<div className="text-center space-y-2">
							<h2 className="text-lg sm:text-xl font-semibold text-gray-12">
								Protected Video
							</h2>
							<p className="text-xs sm:text-sm text-gray-10 max-w-xs sm:max-w-sm px-2 sm:px-0">
								This video is password protected. Please enter the password to
								continue watching.
							</p>
						</div>
					</div>

					<div className="w-full space-y-3 sm:space-y-4">
						<div className="space-y-2">
							<label
								htmlFor="password"
								className="text-sm font-medium text-gray-12"
							>
								Password
							</label>
							<Input
								ref={passwordInputRef}
								id="password"
								type="password"
								value={password}
								onChange={(e) => {
									setPassword(e.target.value);
									if (errorMsg) setErrorMsg(null);
								}}
								placeholder="Enter password"
								className="w-full"
								autoFocus
							/>
							{errorMsg && (
								<p role="alert" className="text-xs text-red-500 mt-1">
									{errorMsg}
								</p>
							)}
						</div>
						<Button
							type="button"
							variant="dark"
							size="lg"
							className="w-full"
							spinner={verifyPassword.isPending}
							disabled={verifyPassword.isPending || !password.trim()}
							onClick={() => verifyPassword.mutate()}
						>
							{verifyPassword.isPending ? "Verifying..." : "Access Video"}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
};
