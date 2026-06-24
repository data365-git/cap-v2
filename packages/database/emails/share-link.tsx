import { CAP_LOGO_URL } from "@cap/utils";
import {
	Body,
	Container,
	Head,
	Heading,
	Html,
	Img,
	Link,
	Section,
	Tailwind,
	Text,
} from "@react-email/components";
import Footer from "./components/Footer";

export function ShareLink({
	senderName = "",
	recipientEmail = "",
	shareUrl = "",
	videoName = "",
	message = "",
}: {
	senderName: string;
	recipientEmail: string;
	shareUrl: string;
	videoName: string;
	message?: string;
}) {
	return (
		<Html>
			<Head />
			<Tailwind>
				<Body className="mx-auto my-auto bg-gray-1 font-sans">
					<Container className="mx-auto my-10 max-w-[500px] rounded border border-solid border-gray-200 px-10 py-5">
						<Section className="mt-8">
							<Img
								src={CAP_LOGO_URL}
								width="40"
								height="40"
								alt="Cap"
								className="mx-auto my-0"
							/>
						</Section>
						<Heading className="mx-0 my-7 p-0 text-center text-xl font-semibold text-black">
							{senderName} shared a recording with you
						</Heading>
						<Text className="text-sm leading-6 text-black">
							<strong>{senderName}</strong> has shared the recording &ldquo;
							{videoName}&rdquo; with you.
						</Text>
						{message && (
							<Text className="text-sm leading-6 text-black rounded bg-gray-50 border border-gray-200 px-4 py-3">
								{message}
							</Text>
						)}
						<Section className="my-8 text-center">
							<Link
								className="rounded-full bg-black px-6 py-3 text-center text-[12px] font-semibold text-white no-underline"
								href={shareUrl}
							>
								Watch Recording
							</Link>
						</Section>
						<Text className="text-sm leading-6 text-black">
							or copy and paste this URL into your browser:
						</Text>
						<Text className="max-w-sm flex-wrap break-words font-medium text-purple-600 no-underline">
							{shareUrl.replace(/^https?:\/\//, "")}
						</Text>
						<Footer email={recipientEmail} marketing={false} />
					</Container>
				</Body>
			</Tailwind>
		</Html>
	);
}
