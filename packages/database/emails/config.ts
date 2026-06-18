import type { JSXElementConstructor, ReactElement } from "react";

export const sendEmail = async ({
	email,
	subject,
}: {
	email: string;
	subject: string;
	react: ReactElement<unknown, string | JSXElementConstructor<unknown>>;
	marketing?: boolean;
	test?: boolean;
	scheduledAt?: string;
	cc?: string | string[];
	replyTo?: string;
	fromOverride?: string;
}): Promise<void> => {
	console.log(
		`[Email sending disabled] Would have sent "${subject}" to ${email}`,
	);
};
