import competitorsData from "../../config/competitors.json" with { type: "json" };

export interface CompetitorConfig {
  name: string;
  org: string;
  blogRssUrl?: string;
  xHandle?: string;
  xEnabled: boolean;
  websiteUrl?: string;
  tags?: string[];
  rssQuality?: "full" | "truncated" | "title_only" | "none";
}

export function getCompetitors(): CompetitorConfig[] {
  return competitorsData as CompetitorConfig[];
}
