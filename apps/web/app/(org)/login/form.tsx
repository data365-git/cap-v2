"use client";

import { Button, Input, LogoBadge } from "@cap/ui";
import { motion } from "framer-motion";
import Cookies from "js-cookie";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { useEffect, useId, useState } from "react";
import type { ChangeEvent } from "react";
import { requestOtp } from "@/actions/auth/request-otp";

const MotionLogoBadge = motion(LogoBadge);
const MotionLink = motion(Link);
const MotionButton = motion(Button);
const MotionInput = motion(Input);

type Mode = "email" | "otp-verify" | "password";

export function LoginForm() {
	const searchParams = useSearchParams();
	const next = searchParams?.get("next");

	const [mode, setMode] = useState<Mode>("email");
	const [email, setEmail] = useState("");
	const [otpCode, setOtpCode] = useState("");
	const [password, setPassword] = useState("");
	const [shownCode, setShownCode] = useState<string | null>(null);
	const [notAllowed, setNotAllowed] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const emailInputId = useId();
	const otpInputId = useId();
	const passwordInputId = useId();

	const theme = Cookies.get("theme") || "light";
	useEffect(() => {
		document.body.className = theme === "dark" ? "dark" : "light";
		return () => { document.body.className = "light"; };
	}, [theme]);

	const redirect = (dest?: string | null) => {
		window.location.href = dest && dest.length > 0 ? dest : "/dashboard";
	};

	// Step 1 — email submitted: check allowed + generate code
	const handleEmailSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setLoading(true);
		setError(null);
		setNotAllowed(false);

		try {
			const result = await requestOtp(email.trim().toLowerCase());
			if (!result.allowed) {
				setNotAllowed(true);
				return;
			}
			setShownCode(result.code ?? null);
			setMode("otp-verify");
		} catch (err: any) {
			setError(err?.message ?? "Something went wrong. Please try again.");
		} finally {
			setLoading(false);
		}
	};

	// Step 2 — code submitted
	const handleVerifyOtp = async (e: React.FormEvent) => {
		e.preventDefault();
		setLoading(true);
		setError(null);

		try {
			const res = await signIn("otp", {
				email: email.trim().toLowerCase(),
				code: otpCode.trim(),
				redirect: false,
			});
			if (res?.ok && !res?.error) {
				redirect(next);
				return;
			}
			setError("Invalid or expired code. Please try again.");
		} catch {
			setError("Something went wrong. Please try again.");
		} finally {
			setLoading(false);
		}
	};

	// Password fallback
	const handlePasswordSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setLoading(true);
		setError(null);

		try {
			const res = await signIn("credentials", {
				email: email.trim().toLowerCase(),
				password,
				redirect: false,
			});
			if (res?.ok && !res?.error) {
				redirect(next);
				return;
			}
			setError("Invalid email or password.");
		} catch {
			setError("Something went wrong. Please try again.");
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
				<motion.h1 key="title" layout="position" className="text-2xl font-semibold text-gray-12">
					Sign in to Cap
				</motion.h1>
				<motion.p key="subtitle" layout="position" className="text-[16px] text-gray-10">
					Beautiful screen recordings, owned by you.
				</motion.p>
			</motion.div>

			<motion.div layout="position" className="flex flex-col space-y-3">

				{/* ── Step 1: email entry ── */}
				{mode === "email" && (
					<form onSubmit={handleEmailSubmit} className="flex flex-col space-y-3 px-1">
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
								setEmail(e.target.value.toLowerCase());
								setNotAllowed(false);
								setError(null);
							}}
						/>

						{notAllowed && (
							<div className="rounded-lg bg-gray-2 border border-gray-5 p-3 text-center">
								<p className="text-sm font-medium text-gray-12 mb-1">
									This email isn't invited yet.
								</p>
								<p className="text-xs text-gray-10">
									Ask your admin to send you an invite link, or contact them to get access.
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
							{loading ? "Checking..." : "Continue"}
						</MotionButton>

						<button
							type="button"
							onClick={() => { setError(null); setNotAllowed(false); setMode("password"); }}
							className="text-xs text-center text-blue-9 hover:text-blue-8 mt-1"
						>
							Sign in with password instead
						</button>
					</form>
				)}

				{/* ── Step 2: code verify ── */}
				{mode === "otp-verify" && (
					<form onSubmit={handleVerifyOtp} className="flex flex-col space-y-3 px-1">
						<p className="text-sm text-gray-10 text-center">
							Enter the 6-digit code for <strong>{email}</strong>
						</p>

						{shownCode && (
							<div className="rounded-lg bg-blue-50 border border-blue-200 p-3 text-center">
								<p className="text-xs text-blue-700 mb-1">Your sign-in code</p>
								<p className="text-2xl font-mono font-bold tracking-widest text-blue-900">
									{shownCode}
								</p>
							</div>
						)}

						<MotionInput
							id={otpInputId}
							name="code"
							autoFocus
							type="text"
							inputMode="numeric"
							placeholder="123456"
							maxLength={6}
							required
							value={otpCode}
							disabled={loading}
							onChange={(e: ChangeEvent<HTMLInputElement>) => setOtpCode(e.target.value.replace(/\D/g, ""))}
						/>

						{error && (
							<p className="text-sm text-red-500 text-center">{error}</p>
						)}

						<MotionButton
							variant="dark"
							type="submit"
							disabled={loading}
							spinner={loading}
						>
							{loading ? "Verifying..." : "Sign in"}
						</MotionButton>

						<button
							type="button"
							onClick={() => { setError(null); setOtpCode(""); setShownCode(null); setMode("email"); }}
							className="text-xs text-center text-blue-9 hover:text-blue-8 mt-1"
						>
							Use a different email
						</button>
					</form>
				)}

				{/* ── Password fallback (hidden by default) ── */}
				{mode === "password" && (
					<form onSubmit={handlePasswordSubmit} className="flex flex-col space-y-3 px-1">
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
							onChange={(e: ChangeEvent<HTMLInputElement>) => setEmail(e.target.value.toLowerCase())}
						/>
						<MotionInput
							id={passwordInputId}
							name="password"
							type="password"
							placeholder="Password"
							autoComplete="current-password"
							required
							value={password}
							disabled={loading}
							onChange={(e: ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
						/>

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

						<button
							type="button"
							onClick={() => { setError(null); setPassword(""); setMode("email"); }}
							className="text-xs text-center text-blue-9 hover:text-blue-8 mt-1"
						>
							Sign in with email code instead
						</button>
					</form>
				)}

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
