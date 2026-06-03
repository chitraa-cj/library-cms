import { Switch, Route } from "wouter";
import { useEffect } from "react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/use-auth";
import { identifyUser, resetUser } from "@/lib/posthog";
import { useAppVersionRefreshPrompt } from "@/hooks/use-app-version";
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
import AdminVocabularyPage from "@/pages/admin-vocabulary";
import BackupsPage from "@/pages/backups";
import BackupDetailPage from "@/pages/backup-detail";
import NotFound from "@/pages/not-found";
import { Loader2, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";

function AuthReconnectBanner({
  onRetry,
  fetching,
}: {
  onRetry: () => void;
  fetching: boolean;
}) {
  return (
    <div className="bg-amber-500/15 border-b border-amber-500/30 px-4 py-2 text-sm flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-amber-950 dark:text-amber-100">
        <WifiOff className="h-4 w-4 shrink-0" />
        <span>
          Connection to the server was interrupted (often during Save &amp; Publish or a server restart).
          You are still signed in — your work in this tab is preserved. Retrying in the background.
        </span>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={fetching}>
        {fetching ? "Retrying…" : "Retry now"}
      </Button>
    </div>
  );
}

function PostHogIdentifier() {
  const { user, isAuthenticated, authDegraded } = useAuth();
  useEffect(() => {
    if (isAuthenticated && user) {
      identifyUser(user.username, {
        display_name: user.displayName ?? user.username,
        role: user.role,
      });
    } else if (!isAuthenticated && !authDegraded) {
      resetUser();
    }
  }, [isAuthenticated, user, authDegraded]);
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
        <Route path="/admin/vocabulary" component={AdminVocabularyPage} />
        <Route path="/admin/backups" component={BackupsPage} />
        <Route path="/admin/backups/:id" component={BackupDetailPage} />
        <Route component={NotFound} />
      </Switch>
    </DashboardLayout>
  );
}

function AppRouter() {
  const { isAuthenticated, isLoading, authDegraded, retryAuth, isFetching } = useAuth();

  if (isLoading && !isAuthenticated) {
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

  return (
    <>
      {authDegraded && (
        <AuthReconnectBanner onRetry={() => void retryAuth()} fetching={isFetching} />
      )}
      <AuthenticatedRoutes />
    </>
  );
}

function AppVersionWatcher() {
  return useAppVersionRefreshPrompt();
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AppVersionWatcher />
        <PostHogIdentifier />
        <Toaster />
        <AppRouter />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
