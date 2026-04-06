import { Switch, Route } from "wouter";
import { useEffect } from "react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/use-auth";
import { identifyUser, resetUser } from "@/lib/posthog";
import DashboardLayout from "@/components/dashboard-layout";
import LoginPage from "@/pages/login";
import DashboardPage from "@/pages/dashboard";
import GranthasPage from "@/pages/granthas";
import SectionsPage from "@/pages/sections";
import TeekasPage from "@/pages/teekas";
import ManthrasPage from "@/pages/manthras";
import ArticlesPage from "@/pages/articles";
import AuthorsPage from "@/pages/authors";
import CategoriesPage from "@/pages/categories";
import AboutPage from "@/pages/about";
import GlobalPage from "@/pages/global";
import AdminUsersPage from "@/pages/admin-users";
import BackupsPage from "@/pages/backups";
import BackupDetailPage from "@/pages/backup-detail";
import NotFound from "@/pages/not-found";
import { Loader2 } from "lucide-react";

function PostHogIdentifier() {
  const { user, isAuthenticated } = useAuth();
  useEffect(() => {
    if (isAuthenticated && user) {
      identifyUser(user.username, {
        display_name: user.displayName ?? user.username,
        role: user.role,
      });
    } else if (!isAuthenticated) {
      resetUser();
    }
  }, [isAuthenticated, user]);
  return null;
}

function AuthenticatedRoutes() {
  return (
    <DashboardLayout>
      <Switch>
        <Route path="/" component={DashboardPage} />
        <Route path="/dashboard" component={DashboardPage} />
        <Route path="/granthas" component={GranthasPage} />
        <Route path="/sections" component={SectionsPage} />
        <Route path="/teekas" component={TeekasPage} />
        <Route path="/manthras" component={ManthrasPage} />
        <Route path="/articles" component={ArticlesPage} />
        <Route path="/authors" component={AuthorsPage} />
        <Route path="/categories" component={CategoriesPage} />
        <Route path="/about" component={AboutPage} />
        <Route path="/global" component={GlobalPage} />
        <Route path="/admin/users" component={AdminUsersPage} />
        <Route path="/admin/backups" component={BackupsPage} />
        <Route path="/admin/backups/:id" component={BackupDetailPage} />
        <Route component={NotFound} />
      </Switch>
    </DashboardLayout>
  );
}

function AppRouter() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return <AuthenticatedRoutes />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <PostHogIdentifier />
        <Toaster />
        <AppRouter />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
