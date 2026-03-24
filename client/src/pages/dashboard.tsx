import { useQuery } from "@tanstack/react-query";
import { STRAPI_POLL_INTERVAL } from "@/hooks/use-strapi-sync";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { BookOpen, FileText, Users, Tag, ScrollText, Hash, Library, ArrowRight } from "lucide-react";
import { Link } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import type { Draft } from "@shared/schema";

const contentSections = [
  {
    key: "granthas",
    label: "Granthas",
    description: "Sacred texts & scriptures",
    icon: BookOpen,
    path: "/granthas",
    color: "text-blue-500",
    bgColor: "bg-blue-500/10",
  },
  {
    key: "sections",
    label: "Sections",
    description: "Adhyaya, Valli, Brahmana divisions",
    icon: ScrollText,
    path: "/sections",
    color: "text-emerald-500",
    bgColor: "bg-emerald-500/10",
  },
  {
    key: "manthras",
    label: "Manthras",
    description: "Verse & mantra entries",
    icon: Hash,
    path: "/manthras",
    color: "text-cyan-500",
    bgColor: "bg-cyan-500/10",
  },
  {
    key: "teekas",
    label: "Teekas",
    description: "Commentary works",
    icon: Library,
    path: "/teekas",
    color: "text-indigo-500",
    bgColor: "bg-indigo-500/10",
  },
  {
    key: "articles",
    label: "Articles",
    description: "Blog articles & content",
    icon: FileText,
    path: "/articles",
    color: "text-amber-500",
    bgColor: "bg-amber-500/10",
  },
  {
    key: "authors",
    label: "Authors",
    description: "Author profiles",
    icon: Users,
    path: "/authors",
    color: "text-violet-500",
    bgColor: "bg-violet-500/10",
  },
  {
    key: "categories",
    label: "Categories",
    description: "Content categories",
    icon: Tag,
    path: "/categories",
    color: "text-pink-500",
    bgColor: "bg-pink-500/10",
  },
];

function StatCard({
  section,
  draftCount,
}: {
  section: (typeof contentSections)[number];
  draftCount: number;
}) {
  const { data, isLoading, error } = useQuery<any>({
    queryKey: ["/api/strapi", section.key, "count"],
    queryFn: async () => {
      const res = await fetch(
        `/api/strapi/${section.key}?pagination[pageSize]=1&fields[0]=id`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: STRAPI_POLL_INTERVAL,
    refetchOnWindowFocus: true,
  });

  return (
    <Link href={section.path}>
      <Card
        className="border-card-border hover:border-primary/30 transition-all duration-200 cursor-pointer group h-full"
        data-testid={`card-${section.key}`}
      >
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div
              className={`w-10 h-10 rounded-xl ${section.bgColor} flex items-center justify-center`}
            >
              <section.icon className={`w-5 h-5 ${section.color}`} />
            </div>
            <div className="flex items-center gap-2">
              {draftCount > 0 && (
                <Badge variant="outline" className="bg-amber-100 text-amber-800 border-amber-300 text-xs" data-testid={`badge-drafts-${section.key}`}>
                  {draftCount} draft{draftCount !== 1 ? "s" : ""}
                </Badge>
              )}
              <ArrowRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <CardTitle className="text-base mb-1">{section.label}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {section.description}
          </p>
          <div className="mt-3">
            {isLoading ? (
              <Skeleton className="h-8 w-12" />
            ) : error ? (
              <span className="text-xs text-destructive">Error loading</span>
            ) : (
              <span
                className="text-2xl font-bold"
                data-testid={`text-count-${section.key}`}
              >
                {data?.meta?.pagination?.total ?? 0}
              </span>
            )}
            <span className="text-xs text-muted-foreground ml-1.5">
              published
            </span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();

  const { data: allDrafts } = useQuery<Draft[]>({
    queryKey: ["/api/drafts"],
    queryFn: async () => {
      const res = await fetch("/api/drafts", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const draftCounts: Record<string, number> = {};
  (allDrafts || []).forEach((d) => {
    if (d.status === "draft") {
      draftCounts[d.contentType] = (draftCounts[d.contentType] || 0) + 1;
    }
  });

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-8">
      <div>
        <h1
          className="text-3xl font-bold tracking-tight"
          data-testid="text-dashboard-title"
        >
          Welcome back, {user?.displayName || user?.username}
        </h1>
        <p className="text-muted-foreground mt-1">
          Manage your Ekatmadham Library content from this dashboard.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {contentSections.map((section) => (
          <StatCard key={section.key} section={section} draftCount={draftCounts[section.key] || 0} />
        ))}
      </div>

      <Card className="border-card-border">
        <CardHeader>
          <CardTitle className="text-base">Quick Start Guide</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="flex items-start gap-3">
              <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                <span className="text-xs font-bold text-primary">1</span>
              </div>
              <div>
                <p className="text-sm font-medium">Create a Grantha</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Start by adding a sacred text with its details and bhashyam
                  information.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                <span className="text-xs font-bold text-primary">2</span>
              </div>
              <div>
                <p className="text-sm font-medium">Build the Structure</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Add Sections (Adhyaya, Khanda, etc.) and Manthras with their translations and teekas.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                <span className="text-xs font-bold text-primary">3</span>
              </div>
              <div>
                <p className="text-sm font-medium">Publish Content</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Your content will be available on the Ekatmadham Library
                  website.
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
