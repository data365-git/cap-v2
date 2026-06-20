"use client";

import { Button, Input, LogoBadge } from "@cap/ui";
import { motion } from "framer-motion";
import Cookies from "js-cookie";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { useEffect, useId, useState } from "react";
import type { ChangeEvent } from "react";
import { checkEmailAllowed } from "@/actions/auth/check-email-allowed";

const MotionLogoBadge = motion(LogoBadge);
const MotionLink = motion(Link);
const MotionButton = motion(Button);
const MotionInput = motion(Input);

export function LoginForm() {
	const searchParams = useSearchParams();
	const next = searchParams?.get("next");

	const [email, setEmail] = useState("");
	const [notAllowed, setNotAllowed] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const emailInputId = useId();

	const theme = Cookies.get("theme") || "light";
	useEffect(() => {
		document.body.className = theme === "dark" ? "dark" : "light";
		return () => {
			document.body.className = "light";
		};
	}, [theme]);

	const redirect = (dest?: string | null) => {
		window.location.href = dest && dest.length > 0 ? dest : "/dashboard";
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setLoading(true);
		setError(null);
		setNotAllowed(false);

		try {
			const normalized = email.trim().toLowerCase();

			// Pre-check so we can show the "contact admin" message without attempting signIn.
			// The provider re-checks server-side — the client result is never trusted for auth.
			const { allowed } = await checkEmailAllowed(normalized);
			if (!allowed) {
				setNotAllowed(true);
				return;
			}

			const res = await signIn("email-only", {
				email: normalized,
				redirect: false,
			});

			if (res?.ok && !res?.error) {
				redirect(next);
				return;
			}

			setError("Sign-in failed. Please try again or contact your administrator.");
		} catch (err: any) {
			setError(err?.message ?? "Something went wrong. Please try again.");
		} finally {
			setLoading(false);
		}
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
				<form onSubmit={handleSubmit} className="flex flex-col space-y-3 px-1">
					<MotionInput
						id={emailInputId}
						name="email"
						autoFocus
						type="email"
						placeholder="tim@apple.com"
						autoComplete="email"
						required
						value={email}
						disabled={loading}
						onChange={(e: ChangeEvent<HTMLInputElement>) => {
							setEmail(e.target.value);
							setNotAllowed(false);
							setError(null);
						}}
					/>

					{notAllowed && (
						<div className="rounded-lg bg-gray-2 border border-gray-5 p-3 text-center">
							<p className="text-sm font-medium text-gray-12 mb-1">
								This email hasn't been invited yet.
							</p>
							<p className="text-xs text-gray-10">
								Please contact your administrator for access.
							</p>
						</div>
					)}

					{error && (
						<p className="text-sm text-red-500 text-center">{error}</p>
					)}

					<MotionButton
						variant="dark"
						type="submit"
						disabled={loading}
						spinner={loading}
					>
						{loading ? "Signing in..." : "Sign in"}
					</MotionButton>
				</form>

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
