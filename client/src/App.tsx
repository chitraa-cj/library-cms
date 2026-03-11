import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/use-auth";
import DashboardLayout from "@/components/dashboard-layout";
import LoginPage from "@/pages/login";
import DashboardPage from "@/pages/dashboard";
import GranthasPage from "@/pages/granthas";
import ChaptersPage from "@/pages/chapters";
import ArticlesPage from "@/pages/articles";
import AuthorsPage from "@/pages/authors";
import CategoriesPage from "@/pages/categories";
import PrasthanaThrayaPage from "@/pages/prasthana-thraya";
import NotFound from "@/pages/not-found";
import { Loader2 } from "lucide-react";

function AuthenticatedRoutes() {
  return (
    <DashboardLayout>
      <Switch>
        <Route path="/" component={DashboardPage} />
        <Route path="/dashboard" component={DashboardPage} />
        <Route path="/granthas" component={GranthasPage} />
        <Route path="/chapters" component={ChaptersPage} />
        <Route path="/articles" component={ArticlesPage} />
        <Route path="/authors" component={AuthorsPage} />
        <Route path="/categories" component={CategoriesPage} />
        <Route path="/prasthana-thraya" component={PrasthanaThrayaPage} />
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
        <Toaster />
        <AppRouter />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
