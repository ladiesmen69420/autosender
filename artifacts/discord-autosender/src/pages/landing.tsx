import { useSignIn, useAuth } from "@clerk/react";
import { useLocation } from "wouter";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function DiscordLogo() {
  return (
    <svg width="22" height="16" viewBox="0 0 22 16" fill="currentColor">
      <path d="M18.59 1.34A18.2 18.2 0 0 0 14.07 0c-.19.34-.4.8-.55 1.16a16.88 16.88 0 0 0-5.04 0A12.6 12.6 0 0 0 7.93 0a18.24 18.24 0 0 0-4.53 1.34C.48 5.57-.29 9.69.09 13.75A18.37 18.37 0 0 0 5.67 16c.45-.61.86-1.26 1.2-1.95a11.9 11.9 0 0 1-1.89-.91c.16-.11.31-.23.46-.35a13.1 13.1 0 0 0 11.12 0c.15.12.3.24.46.35-.6.36-1.23.66-1.89.91.35.69.75 1.34 1.2 1.95a18.32 18.32 0 0 0 5.58-2.25c.46-4.68-.77-8.76-3.32-12.36ZM7.35 11.26c-1.09 0-1.98-.99-1.98-2.21s.87-2.21 1.98-2.21c1.1 0 2 .99 1.98 2.21 0 1.22-.88 2.21-1.98 2.21Zm7.3 0c-1.09 0-1.98-.99-1.98-2.21s.87-2.21 1.98-2.21c1.1 0 2 .99 1.98 2.21 0 1.22-.88 2.21-1.98 2.21Z" />
    </svg>
  );
}

function AppLogo() {
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
      <circle cx="12" cy="18" r="9" stroke="#3b82f6" strokeWidth="3.5" fill="none" />
      <circle cx="24" cy="18" r="9" stroke="#3b82f6" strokeWidth="3.5" fill="none" />
    </svg>
  );
}

export default function Landing() {
  const { signIn, isLoaded } = useSignIn();
  const { isSignedIn } = useAuth();
  const [, setLocation] = useLocation();

  const handleDiscordSignIn = async () => {
    if (!isLoaded || !signIn) return;
    try {
      await signIn.authenticateWithRedirect({
        strategy: "oauth_discord",
        redirectUrl: `${basePath}/sso-callback`,
        redirectUrlComplete: `${basePath}/app`,
      });
    } catch {
      setLocation("/sign-in");
    }
  };

  const handleGetStarted = () => {
    if (isSignedIn) {
      setLocation("/app");
    } else {
      handleDiscordSignIn();
    }
  };

  return (
    <div className="min-h-screen bg-[#0d0d0f] text-white flex flex-col">
      <nav className="flex items-center justify-between px-8 py-5">
        <div className="flex items-center gap-2.5">
          <AppLogo />
          <span className="font-semibold text-base tracking-wide text-gray-100">discord autosender</span>
        </div>
        <button
          onClick={isSignedIn ? () => setLocation("/app") : handleDiscordSignIn}
          className="flex items-center gap-2 bg-[#5865F2] hover:bg-[#4752c4] text-white px-5 py-2.5 rounded-lg font-semibold text-sm transition-colors shadow-lg"
        >
          <DiscordLogo />
          {isSignedIn ? "Go to Dashboard" : "Sign in with Discord"}
        </button>
      </nav>

      <div className="flex flex-1 items-center px-8 py-8 gap-12 max-w-7xl mx-auto w-full">
        <div className="flex-1 min-w-0">
          <h1 className="text-6xl font-black leading-[1.05] mb-6 tracking-tight">
            ADVERTISE<br />
            AROUND THE<br />
            CLOCK
          </h1>
          <p className="text-gray-400 text-lg mb-10 max-w-md leading-relaxed">
            Automatically post your Discord messages in multiple channels all day, so more people
            see your offer without manual reposting.
          </p>
          <button
            onClick={handleGetStarted}
            className="bg-[#3b82f6] hover:bg-[#2563eb] text-white px-8 py-3.5 rounded-xl text-base font-semibold transition-colors shadow-lg"
          >
            Get Started For Free
          </button>
        </div>

        <div className="flex-1 flex flex-col gap-4 min-w-0 max-w-lg">
          <div className="bg-[#111114] border border-[#1f1f24] rounded-2xl p-5">
            <div className="flex items-center justify-between mb-4">
              <span className="font-semibold text-sm">Your Discord Accounts</span>
              <button className="bg-[#3b82f6] hover:bg-[#2563eb] text-white text-xs px-3 py-1.5 rounded-lg font-medium transition-colors">
                Add Discord Account
              </button>
            </div>
            <div className="flex items-center gap-3 p-3 bg-[#18181c] rounded-xl">
              <div className="w-10 h-10 rounded-full bg-[#5865F2] flex items-center justify-center font-bold text-sm flex-shrink-0">
                B
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">brringuwu8756</span>
                  <div className="w-2 h-2 bg-green-400 rounded-full flex-shrink-0" />
                </div>
                <div className="text-gray-500 text-xs truncate">102624907806289372</div>
              </div>
            </div>
          </div>

          <div className="bg-[#111114] border border-[#1f1f24] rounded-2xl p-5">
            <div className="flex items-center justify-between mb-4">
              <span className="font-semibold text-sm">Autosender Campaigns</span>
              <button className="bg-[#3b82f6] hover:bg-[#2563eb] text-white text-xs px-3 py-1.5 rounded-lg font-medium transition-colors">
                Create Campaign
              </button>
            </div>
            <div className="grid grid-cols-4 gap-3 mb-4">
              {[
                { label: "TOTAL", value: "1", color: "text-white" },
                { label: "RUNNING", value: "0", color: "text-green-400" },
                { label: "FAILED", value: "0", color: "text-red-400" },
                { label: "SENT", value: "374", color: "text-white" },
              ].map(({ label, value, color }) => (
                <div key={label}>
                  <div className="text-gray-600 text-[10px] uppercase font-medium mb-1">{label}</div>
                  <div className={`font-bold text-xl ${color}`}>{value}</div>
                </div>
              ))}
            </div>
            <div className="bg-[#18181c] rounded-xl p-3.5">
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">Test</span>
                  <span className="text-[10px] bg-yellow-950 text-yellow-400 px-2 py-0.5 rounded-md font-medium">
                    Stopped
                  </span>
                </div>
              </div>
              <div className="text-gray-500 text-xs mb-3">Account: brringuwu8756</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs mb-4">
                {[
                  { label: "MESSAGES SENT", value: "374" },
                  { label: "FAILED", value: "2" },
                  { label: "INTERVAL", value: "1m" },
                  { label: "CREATED", value: "2025-12-29" },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <div className="text-gray-600 text-[10px] uppercase font-medium">{label}</div>
                    <div className="text-gray-300">{value}</div>
                  </div>
                ))}
              </div>
              <div className="bg-[#3b82f6] text-white text-center text-xs py-2 rounded-lg font-medium">
                ▶ Start Campaign
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
