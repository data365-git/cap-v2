import { faArrowLeft } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import Link from "next/link";
import { ClaimInvite } from "./ClaimInvite";

export default async function InviteLandingPage(props: {
	params: Promise<{ token: string }>;
}) {
	const { token } = await props.params;
	return (
		<div className="flex relative justify-center items-center w-full h-screen bg-gray-2">
			<div className="flex absolute top-10 left-10 gap-2 justify-center items-center transition-opacity hover:opacity-75">
				<FontAwesomeIcon
					className="opacity-75 size-3 text-gray-12"
					icon={faArrowLeft}
				/>
				<Link className="text-gray-12" href="/">
					Home
				</Link>
			</div>
			<ClaimInvite token={token} />
		</div>
	);
}
