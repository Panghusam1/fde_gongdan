import type { Metadata } from "next";

import { Atv320LiveWorkbench } from "@/components/projects/atv320-live-workbench";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "ATV320 工单工作台",
  description:
    "运行ATV320智能工单系统的受控双分支演示，查看来源判断、风险门、方案与人工接管的数据库结果。",
};

export default function Atv320WorkbenchPage() {
  const apiBaseUrl = process.env.NEXT_PUBLIC_ATV320_API_URL ?? "";

  return <Atv320LiveWorkbench apiBaseUrl={apiBaseUrl} />;
}
