import { useEffect, useRef, useLayoutEffect } from "react";
import { Switch, Route, Router as WouterRouter, useLocation, Redirect } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import {
  ClerkProvider, SignIn, SignUp, Show, useClerk, AuthenticateWithRedirectCallback,
} from "@clerk/react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Home from "@/pages/home";
import Landing from "@/pages/landing";
import DiscordSignIn from "@/pages/discord-signin";

function useHideClerkDevBanner() {
  useLayoutEffect(() => {
    function hideDevBanner() {
      document.querySelectorAll<HTMLElement>("a").forEach((el) => {
        if (el.href?.includes("clerk.com") && el.textContent?.includes("Development")) {
          const parent = el.closest<HTMLElement>('[class*="cl-"]') ?? el;
          parent.style.setProperty("display", "none", "important");
        }
      });
    }
    hideDevBanner();
    const observer = new MutationObserver(hideDevBanner);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
}

const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: false,
    },
  },
});

const clerkNoDevBanner = {
  elements: {
    footer: { display: "none" },
  },
};

function SignInPage() {
  return (
    <div className="min-h-screen bg-[#0d0d0f] flex items-center justify-center">
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
        fallbackRedirectUrl={`${basePath}/app`}
        appearance={clerkNoDevBanner}
      />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="min-h-screen bg-[#0d0d0f] flex items-center justify-center">
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in`}
        fallbackRedirectUrl={`${basePath}/app`}
        appearance={clerkNoDevBanner}
      />
    </div>
  );
}

function HomeRedirect() {
  return (
    <>
      <Show when="signed-in">
        <Redirect to="/app" />
      </Show>
      <Show when="signed-out">
        <Landing />
      </Show>
    </>
  );
}

function AppRoute() {
  return (
    <>
      <Show when="signed-in">
        <Home />
      </Show>
      <Show when="signed-out">
        <Redirect to="/" />
      </Show>
    </>
  );
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);

  return null;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
      appearance={{
        elements: {
          badge__devMode: { display: "none" },
          devBrowser: { display: "none" },
        },
      }}
    >
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ClerkQueryClientCacheInvalidator />
          <Switch>
            <Route path="/" component={HomeRedirect} />
            <Route path="/app" component={AppRoute} />
            <Route path="/sign-in/*?" component={SignInPage} />
            <Route path="/sign-up/*?" component={SignUpPage} />
            <Route path="/sso-callback" component={() => (
              <div className="min-h-screen bg-[#0d0d0f] flex items-center justify-center">
                <AuthenticateWithRedirectCallback />
              </div>
            )} />
            <Route path="/discord-signin" component={DiscordSignIn} />
            <Route component={NotFound} />
          </Switch>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function MissingConfigPage() {
  return (
    <div className="min-h-screen bg-[#0d0d0f] flex items-center justify-center p-8">
      <div className="max-w-md text-center space-y-4">
        <div className="text-4xl mb-4">⚙️</div>
        <h1 className="text-2xl font-bold text-white">Setup Required</h1>
        <p className="text-gray-400">
          Add your <span className="text-violet-400 font-mono">VITE_CLERK_PUBLISHABLE_KEY</span> secret in the Replit Secrets panel to enable login.
        </p>
        <p className="text-gray-500 text-sm">
          Copy the Publishable key from your Clerk dashboard → API Keys and paste it into the Replit Secrets tab.
        </p>
      </div>
    </div>
  );
}

function App() {
  useHideClerkDevBanner();

  if (!clerkPubKey) {
    return (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <WouterRouter base={basePath}>
            <Switch>
              <Route path="/" component={MissingConfigPage} />
              <Route component={NotFound} />
            </Switch>
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    );
  }

  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
