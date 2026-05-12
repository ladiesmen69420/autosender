import { useAuth } from "@clerk/react";
import { useLocation } from "wouter";

function LightningIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M13 2L4.09 12.96A1 1 0 0 0 5 14.5h5.5L11 22l8.91-10.96A1 1 0 0 0 19 9.5H13.5L13 2Z" />
    </svg>
  );
}

function DiscordIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24">
      <path fill="#fff" d="M20.3 4.6A16.7 16.7 0 0 0 16.1 3l-.2.4a14 14 0 0 1 3.2 1.5 13.6 13.6 0 0 0-13.3 0A14 14 0 0 1 9 3.4L8.8 3a16.7 16.7 0 0 0-4.2 1.6C2 8.1 1.2 11.9 1.6 15.6c1.8 1.4 3.8 2.4 6 3l.7-1.2c-.8-.3-1.5-.7-2.2-1.1.2-.1.5-.3.7-.4a12 12 0 0 0 11.1 0c.2.1.5.3.7.4-.7.4-1.4.8-2.2 1.1l.7 1.2c2.2-.6 4.2-1.6 6-3 .4-3.7-.4-7.5-2.1-11ZM8.4 13.7c-.8 0-1.5-.7-1.5-1.6s.7-1.6 1.5-1.6c.9 0 1.6.7 1.6 1.6s-.7 1.6-1.6 1.6Zm7.2 0c-.8 0-1.5-.7-1.5-1.6s.7-1.6 1.5-1.6c.9 0 1.6.7 1.6 1.6s-.7 1.6-1.6 1.6Z" />
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
    <div className="min-h-screen bg-[#0a0a0c] text-white flex flex-col md:flex-row overflow-hidden">
      {/* Left panel */}
      <div className="flex-1 flex flex-col justify-between px-10 py-10 md:py-16 relative">
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
          <h1 className="text-5xl md:text-6xl lg:text-7xl font-black leading-[1.0] tracking-tight mb-6">
            ADVERTISE<br />
            AROUND THE<br />
            CLOCK
          </h1>
          <p className="text-gray-400 text-base md:text-lg max-w-md leading-relaxed mb-10">
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
        <div className="h-8 md:hidden" />
      </div>

      {/* Right panel */}
      <div className="w-full md:w-[420px] lg:w-[480px] bg-[#0f0f12] border-l border-white/5 flex items-center justify-center px-8 py-14">
        <div className="w-full max-w-sm flex flex-col items-center gap-6">
          {/* App icon */}
          <div className="w-16 h-16 rounded-2xl bg-[#1a1a20] border border-white/10 flex items-center justify-center shadow-xl">
            <LightningIcon size={28} />
          </div>

          {/* Title & subtitle */}
          <div className="text-center space-y-1.5">
            <h2 className="text-2xl font-bold tracking-tight">DiscordSender</h2>
            <p className="text-gray-400 text-sm leading-relaxed">
              Automate your Discord messages.<br />Sign in to get started.
            </p>
          </div>

          {/* Sign-in buttons */}
          <div className="w-full space-y-3">
            <button
              onClick={handleGetStarted}
              className="w-full flex items-center justify-center gap-2.5 bg-purple-600 hover:bg-purple-500 text-white py-3 rounded-xl font-semibold text-sm transition-colors shadow-lg shadow-purple-900/30"
            >
              <DiscordIcon />
              Continue with Discord or Email
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
  );
}
