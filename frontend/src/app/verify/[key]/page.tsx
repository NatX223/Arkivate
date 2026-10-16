import { VerifyView } from "@/components/VerifyView";

export const metadata = { title: "Verify" };

export default async function VerifyKeyPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return <VerifyView initialKey={key} />;
}
