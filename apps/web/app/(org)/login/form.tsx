"use client";

import { LogoBadge } from "@cap/ui";
import { motion } from "framer-motion";
import Cookies from "js-cookie";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { useEffect, useState } from "react";

const MotionLogoBadge = motion(LogoBadge);
const MotionLink = motion(Link);

export function LoginForm() {
	const searchParams = useSearchParams();
	const next = searchParams?.get("next");
	const notAllowed = searchParams?.get("error") === "AccessDenied";

	const [loading, setLoading] = useState(false);

	const theme = Cookies.get("theme") || "light";
	useEffect(() => {
		document.body.className = theme === "dark" ? "dark" : "light";
		return () => {
			document.body.className = "light";
		};
	}, [theme]);

	const handleGoogle = async () => {
		setLoading(true);
		await signIn("google", { callbackUrl: next || "/dashboard" });
	};

	return (
		<motion.div
			layout
			transition={{ layout: { duration: 0.3, ease: "easeInOut" } }}
			className="overflow-hidden relative w-[calc(100%-5%)] p-[28px] max-w-[432px] bg-gray-3 border border-gray-5 rounded-2xl"
		>
			<MotionLink layout="position" className="flex mx-auto size-fit" href="/">
				<MotionLogoBadge layout="position" className="size-12" />
			</MotionLink>

			<motion.div
				layout="position"
				className="flex flex-col justify-center items-center my-7"
			>
				<motion.h1
					key="title"
					layout="position"
					className="text-2xl font-semibold text-gray-12"
				>
					Sign in to Cap
				</motion.h1>
				<motion.p
					key="subtitle"
					layout="position"
					className="text-[16px] text-gray-10"
				>
					Beautiful screen recordings, owned by you.
				</motion.p>
			</motion.div>

			<motion.div layout="position" className="flex flex-col space-y-3">
				{notAllowed && (
					<div className="rounded-lg bg-gray-2 border border-gray-5 p-3 text-center">
						<p className="text-sm font-medium text-gray-12 mb-1">
							This Google account hasn't been invited yet.
						</p>
						<p className="text-xs text-gray-10">
							Please contact your administrator for access.
						</p>
					</div>
				)}

				<div className="px-1">
					<button
						type="button"
						disabled={loading}
						onClick={handleGoogle}
						className="w-full flex items-center justify-center gap-3 rounded-xl border border-gray-5 bg-white dark:bg-gray-2 px-4 py-2.5 text-sm font-medium text-gray-12 hover:bg-gray-2 dark:hover:bg-gray-3 transition-colors disabled:opacity-50"
					>
						<svg
							className="size-4 shrink-0"
							viewBox="0 0 24 24"
							aria-hidden="true"
						>
							<path
								d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"
								fill="currentColor"
							/>
						</svg>
						{loading ? "Signing in…" : "Sign in with Google"}
					</button>
				</div>

				<motion.p
					layout="position"
					className="pt-3 text-xs text-center text-gray-9"
				>
					By signing in, you acknowledge that you have both read and agree to
					Cap's{" "}
					<Link
						href="/terms"
						target="_blank"
						className="text-xs font-semibold text-gray-12 hover:text-blue-300"
					>
						Terms of Service
					</Link>{" "}
					and{" "}
					<Link
						href="/privacy"
						target="_blank"
						className="text-xs font-semibold text-gray-12 hover:text-blue-300"
					>
						Privacy Policy
					</Link>
					.
				</motion.p>
			</motion.div>
		</motion.div>
	);
}
