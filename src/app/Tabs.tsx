import { TabBar, type TabItem } from "../shared/ui/ui";

export type Page = "strategy" | "results" | "paper" | "account" | "forecast" | "news";
const pages: readonly TabItem<Page>[] = [
  { value: "paper", label: "Trading", controls: "page-paper" },
  { value: "results", label: "Backtest", controls: "page-results" },
  { value: "forecast", label: "Forecast", controls: "page-forecast" },
  { value: "news", label: "News", controls: "page-news" },
  { value: "strategy", label: "Bot settings", controls: "page-strategy" },
  { value: "account", label: "Account", controls: "page-account" },
];

export default function Tabs({
  value,
  onChange,
  newsDot = false,
}: {
  value: Page;
  onChange: (page: Page) => void;
  newsDot?: boolean;
}) {
  return (
    <TabBar
      items={pages.map((page) => (page.value === "news" ? { ...page, dot: newsDot } : page))}
      value={value}
      onChange={onChange}
      label='Main workspace'
      idPrefix='tab'
      className='page-tabs'
    />
  );
}
