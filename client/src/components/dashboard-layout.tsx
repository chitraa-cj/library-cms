import { useAuth } from "@/hooks/use-auth";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  BookOpen,
  FileText,
  Users,
  Tag,
  LayoutDashboard,
  LogOut,
  Menu,
  X,
  ChevronRight,
  Hash,
  ScrollText,
  Library,
  Info,
  Globe,
  ArrowLeft,
  ShieldCheck,
  DatabaseBackup,
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

type NavSection = {
  sectionLabel?: string;
  items: {
    label: string;
    path: string;
    icon: React.ElementType;
    description?: string;
  }[];
};

const navSections: NavSection[] = [
  {
    items: [
      { label: "Dashboard", path: "/dashboard", icon: LayoutDashboard },
    ],
  },
  {
    sectionLabel: "Collection Types",
    items: [
      { label: "Granthas", path: "/granthas", icon: BookOpen, description: "Sacred texts & scriptures" },
      { label: "Sections", path: "/sections", icon: ScrollText, description: "Adhyaya, Valli, Brahmana divisions" },
      { label: "Manthras", path: "/manthras", icon: Hash, description: "Verse & mantra entries" },
      { label: "Teekas", path: "/teekas", icon: Library, description: "Commentary works" },
      { label: "Articles", path: "/articles", icon: FileText, description: "Blog articles & content" },
      { label: "Authors", path: "/authors", icon: Users, description: "Author profiles" },
      { label: "Categories", path: "/categories", icon: Tag, description: "Content categories" },
    ],
  },
  {
    sectionLabel: "Single Types",
    items: [
      { label: "About", path: "/about", icon: Info, description: "About the library" },
      { label: "Global Settings", path: "/global", icon: Globe, description: "Site-wide settings" },
    ],
  },
];

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, logout } = useAuth();
  const [location] = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="h-screen overflow-hidden bg-background flex">
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/50 lg:hidden transition-opacity",
          sidebarOpen ? "opacity-100" : "opacity-0 pointer-events-none"
        )}
        onClick={() => setSidebarOpen(false)}
      />

      <aside
        className={cn(
          "fixed z-50 inset-y-0 left-0 w-72 bg-sidebar border-r border-sidebar-border flex flex-col transition-transform lg:translate-x-0 lg:static lg:z-0 lg:h-full",
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="p-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
              <BookOpen className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h2 className="font-semibold text-sm text-sidebar-foreground">
                Ekatmadham
              </h2>
              <p className="text-xs text-muted-foreground">Content Manager</p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setSidebarOpen(false)}
            data-testid="button-close-sidebar"
          >
            <X className="w-5 h-5" />
          </Button>
        </div>

        <Separator />

        <ScrollArea className="flex-1 py-3">
          <nav className="px-3 space-y-4">
            {navSections.map((section, si) => (
              <div key={si}>
                {section.sectionLabel && (
                  <p className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                    {section.sectionLabel}
                  </p>
                )}
                <div className="space-y-0.5">
                  {section.items.map((item) => {
                    const isActive =
                      location === item.path ||
                      (item.path !== "/dashboard" &&
                        location.startsWith(item.path));
                    return (
                      <Link key={item.path} href={item.path}>
                        <div
                          className={cn(
                            "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors cursor-pointer group",
                            isActive
                              ? "bg-sidebar-accent text-sidebar-foreground font-medium"
                              : "text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
                          )}
                          data-testid={`nav-${item.label.toLowerCase().replace(/\s/g, "-")}`}
                        >
                          <item.icon
                            className={cn(
                              "w-4 h-4 flex-shrink-0",
                              isActive ? "text-primary" : "text-muted-foreground group-hover:text-sidebar-foreground"
                            )}
                          />
                          <span className="flex-1">{item.label}</span>
                          {isActive && (
                            <ChevronRight className="w-4 h-4 text-muted-foreground" />
                          )}
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}

            {/* Snapshots — visible to all authenticated users */}
            <div>
              <p className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                Snapshots
              </p>
              <div className="space-y-0.5">
                {[{ label: "Snapshots", path: "/admin/backups", icon: DatabaseBackup }].map((item) => {
                  const isActive = location.startsWith(item.path);
                  return (
                    <Link key={item.path} href={item.path}>
                      <div
                        className={cn(
                          "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors cursor-pointer group",
                          isActive
                            ? "bg-sidebar-accent text-sidebar-foreground font-medium"
                            : "text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
                        )}
                        data-testid="nav-snapshots"
                      >
                        <item.icon className={cn("w-4 h-4 flex-shrink-0", isActive ? "text-primary" : "text-muted-foreground group-hover:text-sidebar-foreground")} />
                        <span className="flex-1">{item.label}</span>
                        {isActive && <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>

            {/* Admin-only section */}
            {user?.role === "admin" && (
              <div>
                <p className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                  Administration
                </p>
                <div className="space-y-0.5">
                  {[{ label: "User Management", path: "/admin/users", icon: ShieldCheck }].map((item) => {
                    const isActive = location.startsWith(item.path);
                    return (
                      <Link key={item.path} href={item.path}>
                        <div
                          className={cn(
                            "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors cursor-pointer group",
                            isActive
                              ? "bg-sidebar-accent text-sidebar-foreground font-medium"
                              : "text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
                          )}
                          data-testid="nav-user-management"
                        >
                          <item.icon className={cn("w-4 h-4 flex-shrink-0", isActive ? "text-primary" : "text-muted-foreground group-hover:text-sidebar-foreground")} />
                          <span className="flex-1">{item.label}</span>
                          {isActive && <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </div>
            )}
          </nav>
        </ScrollArea>

        <Separator />

        <div className="p-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-xs font-medium text-primary">
              {(user?.displayName || user?.username || "U")
                .charAt(0)
                .toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p
                className="text-sm font-medium truncate"
                data-testid="text-user-display"
              >
                {user?.displayName || user?.username}
              </p>
              <p className="text-xs text-muted-foreground truncate">
                {user?.role || "Editor"}
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-muted-foreground hover:text-destructive"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
            data-testid="button-logout"
          >
            <LogOut className="w-4 h-4 mr-2" />
            Sign Out
          </Button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-30 bg-background/80 backdrop-blur-sm border-b border-border px-4 h-14 flex items-center gap-2">
          {/* Hamburger — mobile only */}
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden shrink-0"
            onClick={() => setSidebarOpen(true)}
            data-testid="button-open-sidebar"
          >
            <Menu className="w-5 h-5" />
          </Button>

          {/* Back button — all screen sizes */}
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            onClick={() => window.history.back()}
            data-testid="button-back"
            title="Go back"
          >
            <ArrowLeft className="w-5 h-5" />
          </Button>

          {/* Current page title */}
          <span className="font-semibold text-sm truncate">
            {navSections.flatMap((s) => s.items).find((i) => i.path !== "/dashboard" ? location.startsWith(i.path) : location === i.path)?.label ?? "Ekatmadham CMS"}
          </span>
        </header>

        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
