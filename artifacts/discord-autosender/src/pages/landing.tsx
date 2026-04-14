import { useAuth } from "@clerk/react";
import { useLocation } from "wouter";

function LightningIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M13 2L4.09 12.96A1 1 0 0 0 5 14.5h5.5L11 22l8.91-10.96A1 1 0 0 0 19 9.5H13.5L13 2Z" />
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24">
      <path fill="#fff" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09Z" />
      <path fill="#fff" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23Z" />
      <path fill="#fff" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84Z" />
      <path fill="#fff" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53Z" />
    </svg>
  );
}

export default function Landing() {
  const { isSignedIn } = useAuth();
  const [, setLocation] = useLocation();

  const handleGetStarted = () => {
    if (isSignedIn) {
      setLocation("/app");
    } else {
      setLocation("/sign-in");
    }
  };

  return (
    <div className="h-screen bg-[#0a0a0c] text-white flex justify-center overflow-hidden">
      <div className="h-screen w-full max-w-[840px] flex flex-col border-x border-white/5 bg-[#0b0b0e]">
      {/* Left panel */}
      <div className="flex flex-col justify-between px-8 py-5 md:px-12 md:py-6 relative flex-1 min-h-0">
        {/* Subtle background gradient */}
        <div className="absolute inset-0 bg-gradient-to-br from-purple-950/20 via-transparent to-transparent pointer-events-none" />

        {/* Logo */}
        <div className="relative">
          <div className="w-11 h-11 rounded-xl bg-purple-600 flex items-center justify-center shadow-lg shadow-purple-900/40">
            <LightningIcon size={20} />
          </div>
        </div>

        {/* Headline */}
        <div className="relative flex flex-col justify-center py-4">
          <h1 className="text-5xl font-black leading-[1.0] tracking-tight mb-4">
            ADVERTISE<br />
            AROUND THE<br />
            CLOCK
          </h1>
          <p className="text-gray-400 text-base max-w-md leading-relaxed mb-5">
            Automatically post your Discord messages in multiple channels all day, so more people
            see your offer without manual reposting.
          </p>
          <button
            onClick={handleGetStarted}
            className="w-fit bg-purple-600 hover:bg-purple-500 text-white px-8 py-3.5 rounded-xl text-base font-semibold transition-colors shadow-lg shadow-purple-900/30"
          >
            Get Started For Free
          </button>
        </div>

        {/* Spacer for bottom */}
        <div className="h-0" />
      </div>

      {/* Right panel */}
      <div className="w-full h-[285px] bg-[#0f0f12] border-t border-white/5 flex items-center justify-center px-8 py-4 shrink-0 overflow-hidden">
        <div className="w-full max-w-md flex flex-col items-center gap-2.5">
          {/* App icon */}
          <div className="w-12 h-12 rounded-2xl bg-[#1a1a20] border border-white/10 flex items-center justify-center shadow-xl">
            <LightningIcon size={22} />
          </div>

          {/* Title & subtitle */}
          <div className="text-center space-y-1.5">
            <h2 className="text-xl font-bold tracking-tight">DiscordSender</h2>
            <p className="text-gray-400 text-xs leading-relaxed">
              Automate your Discord messages.<br />Sign in to get started.
            </p>
          </div>

          {/* Sign-in buttons */}
          <div className="w-full space-y-2">
            <button
              onClick={handleGetStarted}
              className="w-full flex items-center justify-center gap-2.5 bg-purple-600 hover:bg-purple-500 text-white py-2.5 rounded-xl font-semibold text-sm transition-colors shadow-lg shadow-purple-900/30"
            >
              <GoogleIcon />
              Continue with Google or Email
            </button>
          </div>

          {/* Feature tags */}
          <div className="flex flex-wrap justify-center gap-2">
            {["Scheduled Messages", "Multi-Server", "Campaigns"].map((tag) => (
              <span
                key={tag}
                className="text-xs text-gray-400 border border-white/10 rounded-full px-3 py-1 bg-white/5"
              >
                {tag}
              </span>
            ))}
          </div>

          {/* ToS */}
          <p className="text-xs text-gray-600 text-center leading-relaxed">
            By signing in, you agree to our{" "}
            <span className="text-gray-400 underline cursor-pointer">Terms of Service</span>{" "}
            and{" "}
            <span className="text-gray-400 underline cursor-pointer">Privacy Policy</span>.
          </p>
        </div>
      </div>
      </div>
    </div>
  );
}
