import { Atv320LiveWorkbench } from "@/components/projects/atv320-live-workbench";

export const dynamic = "force-static";

export default function HomePage() {
  const apiBaseUrl = process.env.NEXT_PUBLIC_ATV320_API_URL ?? "";

  return <Atv320LiveWorkbench apiBaseUrl={apiBaseUrl} />;
}
