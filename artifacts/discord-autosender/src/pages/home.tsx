import React, { useState, useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useValidateToken,
  useSendMessages,
  useListSessions,
  useCreateSession,
  useDeleteSession,
  useGenerateAIReply,
  useRunAutoReply,
  useFetchDMs,
  getListSessionsQueryKey,
} from "@workspace/api-client-react";
import type { TokenValidationResult, DMConversation } from "@workspace/api-client-react/src/generated/api.schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Slider } from "@/components/ui/slider";
import { useToast } from "@/hooks/use-toast";
import {
  LayoutDashboard, Zap, Key, Bot, History, ChevronRight,
  Play, Square, Save, Trash2, RefreshCw, Plus,
  Activity, Clock, TrendingUp, MessageSquare,
  Cpu, Radio, AlertTriangle, CheckCircle, XCircle, Loader2,
  ChevronDown, ChevronUp, Copy,
} from "lucide-react";

type View = "dashboard" | "autosender" | "ai-reply" | "tokens" | "logs";

type Campaign = {
  id: string;
  name: string;
  token: string;
  channelsInput: string;
  message: string;
  delay: number;
  jitter: number;
  running: boolean;
  sentCount: number;
  failedCount: number;
  nextSend: number | null;
  expanded: boolean;
  tokenValid: boolean | null;
};

type LogEntry = {
  id: string;
  timestamp: Date;
  message: string;
  type: "info" | "success" | "error";
  campaign?: string;
  view?: View;
};

function makeCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: Math.random().toString(36).substring(2, 10),
    name: "Campaign " + Math.floor(Math.random() * 900 + 100),
    token: "",
    channelsInput: "",
    message: "",
    delay: 15,
    jitter: 0,
    running: false,
    sentCount: 0,
    failedCount: 0,
    nextSend: null,
    expanded: true,
    tokenValid: null,
    ...overrides,
  };
}

export default function Home() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // API Hooks
  const validateTokenMutation = useValidateToken();
  const sendMessagesMutation = useSendMessages();
  const { data: sessions = [], isLoading: sessionsLoading } = useListSessions();
  const createSessionMutation = useCreateSession();
  const deleteSessionMutation = useDeleteSession();
  const generateAIReplyMutation = useGenerateAIReply();
  const runAutoReplyMutation = useRunAutoReply();
  const fetchDMsMutation = useFetchDMs();

  // Navigation
  const [activeView, setActiveView] = useState<View>("dashboard");

  // Campaigns
  const [campaigns, setCampaigns] = useState<Campaign[]>([makeCampaign({ name: "Campaign 1" })]);
  const campaignsRef = useRef<Campaign[]>(campaigns);

  // Countdown display
  const [now, setNow] = useState(Date.now());

  // Token page state
  const [tokenInput, setTokenInput] = useState("");
  const [tokenInfo, setTokenInfo] = useState<TokenValidationResult | null>(null);

  // AI Reply state
  const [aiPersona, setAiPersona] = useState("");
  const [aiContext, setAiContext] = useState("");
  const [aiChannelId, setAiChannelId] = useState("");
  const [generatedReply, setGeneratedReply] = useState("");
  const [dms, setDMs] = useState<DMConversation[]>([]);
  const [aiToken, setAiToken] = useState("");
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(false);
  const autoReplyRef = useRef(autoReplyEnabled);
  autoReplyRef.current = autoReplyEnabled;

  // Logs
  const [logs, setLogs] = useState<LogEntry[]>([]);

  // Timers map: campaign id -> timeout id
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Keep campaigns ref in sync
  useEffect(() => {
    campaignsRef.current = campaigns;
  }, [campaigns]);

  // Countdown tick
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, []);

  const addLog = useCallback((msg: string, type: "info" | "success" | "error", view?: View, campaign?: string) => {
    setLogs((prev) => [
      { id: Math.random().toString(36).substring(7), timestamp: new Date(), message: msg, type, view, campaign },
      ...prev,
    ].slice(0, 500));
  }, []);

  const updateCampaign = useCallback((id: string, updates: Partial<Campaign>) => {
    setCampaigns((prev) => prev.map((c) => (c.id === id ? { ...c, ...updates } : c)));
  }, []);

  // The send fn (stored in ref to avoid stale closures)
  const sendFnRef = useRef<(campaignId: string) => Promise<void>>();

  useEffect(() => {
    sendFnRef.current = async (campaignId: string) => {
      const campaign = campaignsRef.current.find((c) => c.id === campaignId);
      if (!campaign || !campaign.running) {
        timersRef.current.delete(campaignId);
        return;
      }

      const channels = campaign.channelsInput
        .split(/[\n,]+/)
        .map((c) => c.trim())
        .filter(Boolean);

      if (!campaign.token || channels.length === 0 || !campaign.message) {
        addLog(`[${campaign.name}] Missing token, channels, or message — stopping.`, "error", "autosender", campaign.name);
        setCampaigns((prev) => prev.map((c) => c.id === campaignId ? { ...c, running: false, nextSend: null } : c));
        timersRef.current.delete(campaignId);
        return;
      }

      try {
        const res = await sendMessagesMutation.mutateAsync({
          data: { token: campaign.token, channels, message: campaign.message },
        });

        const fresh = campaignsRef.current.find((c) => c.id === campaignId);
        setCampaigns((prev) =>
          prev.map((c) =>
            c.id === campaignId
              ? { ...c, sentCount: c.sentCount + res.sent, failedCount: c.failedCount + res.failed }
              : c,
          ),
        );

        if (res.failed > 0) {
          addLog(`[${campaign.name}] Sent ${res.sent}, failed ${res.failed}.`, "error", "autosender", campaign.name);
        } else {
          addLog(`[${campaign.name}] Delivered to ${res.sent} channel(s).`, "success", "autosender", campaign.name);
        }
      } catch (err: any) {
        addLog(`[${campaign.name}] Send error: ${err?.message ?? "Unknown"}`, "error", "autosender", campaign.name);
        setCampaigns((prev) =>
          prev.map((c) =>
            c.id === campaignId ? { ...c, failedCount: c.failedCount + channels.length } : c,
          ),
        );
      }

      // Check if still running
      const fresh = campaignsRef.current.find((c) => c.id === campaignId);
      if (!fresh?.running) {
        timersRef.current.delete(campaignId);
        return;
      }

      // Schedule next
      const jitterMs =
        fresh.jitter > 0 ? (fresh.delay * 1000 * (Math.random() * fresh.jitter)) / 100 : 0;
      const totalDelay = fresh.delay * 1000 + jitterMs;

      setCampaigns((prev) =>
        prev.map((c) =>
          c.id === campaignId ? { ...c, nextSend: Date.now() + totalDelay } : c,
        ),
      );

      const timer = setTimeout(() => sendFnRef.current?.(campaignId), totalDelay);
      timersRef.current.set(campaignId, timer);
    };
  }, [sendMessagesMutation, addLog]);

  // Watch campaign running state changes
  const prevRunningRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const currentlyRunning = new Set(campaigns.filter((c) => c.running).map((c) => c.id));

    // Start newly running campaigns
    for (const campaign of campaigns) {
      if (campaign.running && !prevRunningRef.current.has(campaign.id)) {
        if (!timersRef.current.has(campaign.id)) {
          addLog(`[${campaign.name}] Campaign started.`, "info", "autosender", campaign.name);
          sendFnRef.current?.(campaign.id);
        }
      }
    }

    // Stop campaigns that became non-running
    for (const id of prevRunningRef.current) {
      if (!currentlyRunning.has(id)) {
        const timer = timersRef.current.get(id);
        if (timer) clearTimeout(timer);
        timersRef.current.delete(id);
        const camp = campaigns.find((c) => c.id === id);
        if (camp) {
          addLog(`[${camp.name}] Campaign stopped.`, "info", "autosender", camp.name);
          setCampaigns((prev) => prev.map((c) => c.id === id ? { ...c, nextSend: null } : c));
        }
      }
    }

    prevRunningRef.current = currentlyRunning;
  }, [campaigns.map((c) => `${c.id}:${c.running}`).join(","), addLog]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      for (const timer of timersRef.current.values()) clearTimeout(timer);
    };
  }, []);

  // Auto-reply loop
  useEffect(() => {
    if (!autoReplyEnabled || !aiToken) return;
    let intervalId: ReturnType<typeof setInterval>;

    const runAutoReply = async () => {
      if (!autoReplyRef.current) return;
      addLog("Running AI auto-reply scan...", "info", "ai-reply");
      try {
        const res = await runAutoReplyMutation.mutateAsync({
          data: { token: aiToken, persona: aiPersona || undefined },
        });
        if (res.replied > 0)
          addLog(`Auto-replied to ${res.replied} DM(s), skipped ${res.skipped}.`, "success", "ai-reply");
        else
          addLog(`Auto-reply scan: ${res.skipped} DM(s) already replied or empty.`, "info", "ai-reply");
      } catch {
        addLog("Auto-reply scan failed.", "error", "ai-reply");
      }
    };

    runAutoReply();
    intervalId = setInterval(runAutoReply, 60000);
    return () => clearInterval(intervalId);
  }, [autoReplyEnabled, aiToken]);

  // Token validation (Tokens page)
  const handleValidateToken = async () => {
    if (!tokenInput) return;
    try {
      const result = await validateTokenMutation.mutateAsync({ data: { token: tokenInput } });
      setTokenInfo(result);
      if (result.valid) {
        addLog(`Token validated: ${result.username}#${result.discriminator} (${result.id})`, "success", "tokens");
        toast({ title: "Token Valid", description: `Authenticated as ${result.username}` });
      } else {
        addLog(`Token rejected: ${result.error}`, "error", "tokens");
        toast({ title: "Invalid Token", description: result.error || "Token rejected", variant: "destructive" });
      }
    } catch {
      addLog("Network error validating token", "error", "tokens");
      toast({ title: "Error", description: "Failed to reach validation service.", variant: "destructive" });
    }
  };

  // Validate campaign token
  const handleValidateCampaignToken = async (campaignId: string, token: string) => {
    if (!token) return;
    try {
      const result = await validateTokenMutation.mutateAsync({ data: { token } });
      updateCampaign(campaignId, { tokenValid: result.valid ?? false });
      if (result.valid) {
        addLog(`[Campaign] Token valid: ${result.username}`, "success", "autosender");
        toast({ title: "Valid", description: `${result.username}#${result.discriminator}` });
      } else {
        addLog(`[Campaign] Token invalid: ${result.error}`, "error", "autosender");
        toast({ title: "Invalid Token", description: result.error || "Rejected", variant: "destructive" });
      }
    } catch {
      updateCampaign(campaignId, { tokenValid: false });
    }
  };

  const handleSaveSession = async (campaign: Campaign) => {
    const channels = campaign.channelsInput.split(/[\n,]+/).map((c) => c.trim()).filter(Boolean);
    try {
      await createSessionMutation.mutateAsync({
        data: { name: campaign.name, token: campaign.token, channels, message: campaign.message, delay: campaign.delay, jitter: campaign.jitter },
      });
      toast({ title: "Preset Saved", description: `"${campaign.name}" saved.` });
      queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
      addLog(`Preset saved: ${campaign.name}`, "success", "autosender");
    } catch {
      toast({ title: "Error", description: "Failed to save preset.", variant: "destructive" });
    }
  };

  const handleLoadSession = (session: any, campaignId: string) => {
    updateCampaign(campaignId, {
      token: session.token,
      channelsInput: session.channels.join("\n"),
      message: session.message,
      delay: session.delay,
      jitter: session.jitter || 0,
      tokenValid: null,
    });
    addLog(`Preset "${session.name}" loaded into campaign.`, "info", "autosender");
    toast({ title: "Preset Loaded", description: session.name });
  };

  const handleDeleteSession = async (id: number) => {
    try {
      await deleteSessionMutation.mutateAsync({ id });
      queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
    } catch {
      toast({ title: "Error", description: "Failed to delete preset.", variant: "destructive" });
    }
  };

  const handleFetchDMs = async () => {
    if (!aiToken) return;
    try {
      const result = await fetchDMsMutation.mutateAsync({ data: { token: aiToken } });
      setDMs(result);
      addLog(`Fetched ${result.length} DM conversation(s).`, "success", "ai-reply");
    } catch {
      addLog("Failed to fetch DMs.", "error", "ai-reply");
      toast({ title: "Error", description: "Could not fetch DMs.", variant: "destructive" });
    }
  };

  const handleGenerateAIReply = async (contextOverride?: string, channelOverride?: string) => {
    const ctx = contextOverride ?? aiContext;
    if (!ctx) return;
    try {
      const res = await generateAIReplyMutation.mutateAsync({
        data: {
          context: ctx,
          persona: aiPersona || undefined,
          token: channelOverride ? aiToken : undefined,
          channelId: channelOverride,
        },
      });
      setGeneratedReply(res.reply);
      addLog(`AI reply generated${res.sent ? " and sent" : ""}.`, "success", "ai-reply");
      if (res.sent) toast({ title: "Reply Sent", description: "AI reply delivered." });
    } catch {
      addLog("AI reply generation failed.", "error", "ai-reply");
    }
  };

  const totalSent = campaigns.reduce((s, c) => s + c.sentCount, 0);
  const totalFailed = campaigns.reduce((s, c) => s + c.failedCount, 0);
  const runningCount = campaigns.filter((c) => c.running).length;
  const successRate =
    totalSent + totalFailed > 0
      ? ((totalSent / (totalSent + totalFailed)) * 100).toFixed(1)
      : "100.0";

  const navItems: { id: View; icon: React.ReactNode; label: string }[] = [
    { id: "dashboard", icon: <LayoutDashboard className="w-4 h-4" />, label: "Dashboard" },
    { id: "autosender", icon: <Radio className="w-4 h-4" />, label: "AutoSender" },
    { id: "ai-reply", icon: <Bot className="w-4 h-4" />, label: "AI Reply" },
    { id: "tokens", icon: <Key className="w-4 h-4" />, label: "Tokens" },
    { id: "logs", icon: <History className="w-4 h-4" />, label: "Logs" },
  ];

  return (
    <div className="h-screen flex bg-background text-foreground overflow-hidden">
      {/* Sidebar */}
      <aside className="w-52 bg-sidebar border-r border-sidebar-border flex flex-col shrink-0">
        <div className="px-4 py-5 border-b border-sidebar-border">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded bg-primary flex items-center justify-center glow-primary shrink-0">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <div>
              <div className="font-bold text-sm text-foreground leading-none">SentinelBot</div>
              <div className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-0.5">v2.0</div>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-2 py-3 space-y-0.5">
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveView(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded text-sm font-medium transition-all duration-150 group ${
                activeView === item.id
                  ? "bg-primary/15 text-primary border border-primary/20"
                  : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground"
              }`}
            >
              <span className={activeView === item.id ? "text-primary" : "text-muted-foreground group-hover:text-foreground"}>
                {item.icon}
              </span>
              {item.label}
              {item.id === "autosender" && runningCount > 0 && (
                <span className="ml-auto text-[10px] bg-green-500/20 text-green-400 border border-green-500/30 rounded px-1.5 py-0.5 font-mono">
                  {runningCount}
                </span>
              )}
              {activeView === item.id && runningCount === 0 && (
                <ChevronRight className="w-3 h-3 ml-auto text-primary" />
              )}
            </button>
          ))}
        </nav>

        <div className="px-4 py-3 border-t border-sidebar-border">
          <div className="flex items-center gap-2 mb-1">
            <div className={`w-1.5 h-1.5 rounded-full ${runningCount > 0 ? "bg-green-400 animate-pulse" : "bg-muted-foreground"}`} />
            <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">
              {runningCount > 0 ? `${runningCount} Live` : "Idle"}
            </span>
          </div>
          <div className="text-[11px] text-foreground/50 font-mono">{campaigns.length} campaign{campaigns.length !== 1 ? "s" : ""}</div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="border-b border-border bg-card/40 px-6 py-3.5 flex items-center justify-between shrink-0">
          <div>
            <h1 className="text-base font-semibold text-foreground capitalize">
              {activeView === "ai-reply" ? "AI Reply" : activeView}
            </h1>
            <p className="text-xs text-muted-foreground">
              {activeView === "dashboard" && "Your Discord automation command center"}
              {activeView === "autosender" && `${campaigns.length} campaign${campaigns.length !== 1 ? "s" : ""} — ${runningCount} active`}
              {activeView === "ai-reply" && "Generate natural, context-aware DM replies"}
              {activeView === "tokens" && "Validate and manage Discord user tokens"}
              {activeView === "logs" && "Real-time activity and event log"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {runningCount > 0 && (
              <Badge className="bg-green-500/10 text-green-400 border-green-500/20 font-mono text-[10px] animate-pulse">
                {runningCount} LIVE
              </Badge>
            )}
            <Badge variant="outline" className="font-mono text-[10px] border-border text-muted-foreground">
              {logs.length} events
            </Badge>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-6">

          {/* === DASHBOARD === */}
          {activeView === "dashboard" && (
            <div className="space-y-6 max-w-5xl">
              <div className="flex items-start gap-3 p-3 rounded border border-amber-500/20 bg-amber-500/5 text-amber-400/90">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <p className="text-xs leading-relaxed">
                  Self-botting via user tokens violates Discord's Terms of Service and may result in permanent account termination. Use at your own risk.
                </p>
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                {[
                  { label: "Campaigns", value: campaigns.length, icon: <Radio className="w-4 h-4" />, sub: `${runningCount} running`, color: "text-primary" },
                  { label: "Presets", value: sessions.length, icon: <Save className="w-4 h-4" />, sub: "Saved configs", color: "text-cyan-400" },
                  { label: "Channels", value: campaigns.reduce((s, c) => s + c.channelsInput.split(/[\n,]+/).filter(Boolean).length, 0), icon: <MessageSquare className="w-4 h-4" />, sub: "All campaigns", color: "text-violet-300" },
                  { label: "Messages Sent", value: totalSent, icon: <Activity className="w-4 h-4" />, sub: "All time total", color: "text-green-400" },
                  { label: "Success Rate", value: `${successRate}%`, icon: <TrendingUp className="w-4 h-4" />, sub: totalSent + totalFailed > 0 ? "Combined" : "No data", color: totalFailed === 0 ? "text-green-400" : "text-amber-400" },
                ].map((stat) => (
                  <div key={stat.label} className="stat-card p-4 rounded border border-border bg-card/60 backdrop-blur">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{stat.label}</span>
                      <span className={stat.color}>{stat.icon}</span>
                    </div>
                    <div className={`text-2xl font-bold font-mono ${stat.color}`}>{stat.value}</div>
                    <div className="text-[10px] text-muted-foreground mt-1">{stat.sub}</div>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="rounded border border-border bg-card/60 p-4">
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-2">
                    <Zap className="w-3.5 h-3.5 text-primary" /> Quick Actions
                  </h3>
                  <div className="space-y-1.5">
                    {[
                      { label: "Configure campaigns", onClick: () => setActiveView("autosender"), icon: <Radio className="w-3.5 h-3.5" /> },
                      { label: "Set up AI persona", onClick: () => setActiveView("ai-reply"), icon: <Bot className="w-3.5 h-3.5" /> },
                      { label: "Validate a token", onClick: () => setActiveView("tokens"), icon: <Key className="w-3.5 h-3.5" /> },
                      { label: "View activity logs", onClick: () => setActiveView("logs"), icon: <History className="w-3.5 h-3.5" /> },
                    ].map((action) => (
                      <button
                        key={action.label}
                        onClick={action.onClick}
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded text-sm text-foreground/80 hover:text-foreground hover:bg-secondary/60 transition-colors border border-border hover:border-primary/30 group"
                      >
                        <span className="text-primary">{action.icon}</span>
                        {action.label}
                        <ChevronRight className="w-3.5 h-3.5 ml-auto opacity-0 group-hover:opacity-100 text-primary transition-opacity" />
                      </button>
                    ))}
                  </div>
                </div>

                <div className="rounded border border-border bg-card/60 p-4">
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-2">
                    <Activity className="w-3.5 h-3.5 text-primary" /> Campaign Status
                  </h3>
                  {campaigns.length === 0 ? (
                    <div className="text-center py-6 text-muted-foreground text-xs font-mono">No campaigns yet.</div>
                  ) : (
                    <div className="space-y-2">
                      {campaigns.map((c) => (
                        <div key={c.id} className="flex items-center gap-3 px-3 py-2 rounded border border-border bg-background/30">
                          <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${c.running ? "bg-green-400 animate-pulse" : "bg-muted-foreground/40"}`} />
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-medium truncate">{c.name}</div>
                            <div className="text-[10px] text-muted-foreground font-mono">
                              {c.channelsInput.split(/[\n,]+/).filter(Boolean).length} ch · {c.delay}s
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <div className="text-xs font-mono text-green-400">{c.sentCount}</div>
                            <div className="text-[10px] text-muted-foreground">sent</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {logs.length > 0 && (
                <div className="rounded border border-border bg-card/60 p-4">
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-2">
                    <Activity className="w-3.5 h-3.5 text-primary" /> Recent Activity
                  </h3>
                  <div className="space-y-1.5">
                    {logs.slice(0, 5).map((log) => (
                      <div key={log.id} className="flex items-start gap-2 text-xs">
                        {log.type === "success" && <CheckCircle className="w-3 h-3 text-green-400 mt-0.5 shrink-0" />}
                        {log.type === "error" && <XCircle className="w-3 h-3 text-red-400 mt-0.5 shrink-0" />}
                        {log.type === "info" && <div className="w-3 h-3 mt-0.5 shrink-0 flex items-center justify-center"><div className="w-1.5 h-1.5 rounded-full bg-blue-400" /></div>}
                        <span className="text-foreground/70 leading-relaxed flex-1">{log.message}</span>
                        <span className="text-muted-foreground whitespace-nowrap font-mono shrink-0">
                          {log.timestamp.toLocaleTimeString(undefined, { hour12: false })}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* === AUTOSENDER (Multi-Campaign) === */}
          {activeView === "autosender" && (
            <div className="max-w-4xl space-y-4">
              {/* Header actions */}
              <div className="flex items-center justify-between">
                <div className="text-xs text-muted-foreground">
                  Run multiple campaigns simultaneously with different accounts and settings.
                </div>
                <Button
                  size="sm"
                  className="h-8 bg-primary/80 hover:bg-primary text-white gap-1.5"
                  onClick={() => setCampaigns((p) => [...p, makeCampaign({ name: `Campaign ${p.length + 1}` })])}
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Campaign
                </Button>
              </div>

              {/* Campaigns list */}
              {campaigns.length === 0 && (
                <div className="text-center py-16 text-muted-foreground text-sm border border-dashed border-border/50 rounded">
                  No campaigns yet. Click "Add Campaign" to get started.
                </div>
              )}

              {campaigns.map((campaign) => {
                const channels = campaign.channelsInput.split(/[\n,]+/).filter(Boolean);
                const canStart = !!campaign.token && channels.length > 0 && !!campaign.message;
                const countdown = campaign.nextSend
                  ? Math.max(0, (campaign.nextSend - now) / 1000).toFixed(1)
                  : null;

                return (
                  <div
                    key={campaign.id}
                    className={`rounded border bg-card/60 transition-colors ${
                      campaign.running ? "border-primary/30 shadow-[0_0_16px_rgba(124,58,237,0.08)]" : "border-border"
                    }`}
                  >
                    {/* Campaign Header */}
                    <div className="flex items-center gap-3 px-4 py-3">
                      <div className={`w-2 h-2 rounded-full shrink-0 ${campaign.running ? "bg-green-400 animate-pulse" : "bg-muted-foreground/30"}`} />

                      <Input
                        value={campaign.name}
                        onChange={(e) => updateCampaign(campaign.id, { name: e.target.value })}
                        className="h-7 text-sm font-semibold bg-transparent border-none shadow-none px-0 focus-visible:ring-0 flex-1 min-w-0"
                        disabled={campaign.running}
                      />

                      {campaign.running && countdown && (
                        <div className="text-xs font-mono text-primary shrink-0">
                          next: {countdown}s
                        </div>
                      )}

                      <div className="flex items-center gap-1.5 shrink-0">
                        {/* Stats */}
                        {(campaign.sentCount > 0 || campaign.failedCount > 0) && (
                          <div className="flex items-center gap-1.5 mr-1">
                            <span className="text-[11px] font-mono text-green-400">{campaign.sentCount} sent</span>
                            {campaign.failedCount > 0 && (
                              <span className="text-[11px] font-mono text-red-400">{campaign.failedCount} fail</span>
                            )}
                          </div>
                        )}

                        {/* Start/Stop */}
                        <Button
                          size="sm"
                          className={`h-7 px-3 text-xs font-bold ${
                            campaign.running
                              ? "bg-red-600/80 hover:bg-red-600 text-white"
                              : "bg-primary/80 hover:bg-primary text-white"
                          }`}
                          onClick={() => updateCampaign(campaign.id, { running: !campaign.running })}
                          disabled={!canStart && !campaign.running}
                          title={!canStart && !campaign.running ? "Set token, channels, and message first" : undefined}
                        >
                          {campaign.running ? (
                            <><Square className="w-3 h-3 mr-1 fill-current" />Stop</>
                          ) : (
                            <><Play className="w-3 h-3 mr-1 fill-current" />Start</>
                          )}
                        </Button>

                        {/* Save preset */}
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-muted-foreground hover:text-primary"
                          title="Save as preset"
                          onClick={() => handleSaveSession(campaign)}
                          disabled={!campaign.token || !campaign.message}
                        >
                          <Save className="w-3.5 h-3.5" />
                        </Button>

                        {/* Expand/Collapse */}
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-muted-foreground"
                          onClick={() => updateCampaign(campaign.id, { expanded: !campaign.expanded })}
                          disabled={campaign.running}
                        >
                          {campaign.expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                        </Button>

                        {/* Delete */}
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-muted-foreground hover:text-red-400"
                          onClick={() => {
                            if (campaign.running) {
                              updateCampaign(campaign.id, { running: false });
                              setTimeout(() => setCampaigns((p) => p.filter((c) => c.id !== campaign.id)), 200);
                            } else {
                              setCampaigns((p) => p.filter((c) => c.id !== campaign.id));
                            }
                          }}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>

                    {/* Campaign Body */}
                    {campaign.expanded && (
                      <div className="px-4 pb-4 pt-0 border-t border-border/50 grid grid-cols-1 lg:grid-cols-2 gap-4 mt-0">
                        {/* Left column */}
                        <div className="space-y-3 pt-4">
                          {/* Token */}
                          <div>
                            <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center justify-between">
                              Discord Token
                              {campaign.tokenValid === true && <span className="text-green-400 flex items-center gap-1"><CheckCircle className="w-3 h-3" />Valid</span>}
                              {campaign.tokenValid === false && <span className="text-red-400 flex items-center gap-1"><XCircle className="w-3 h-3" />Invalid</span>}
                            </Label>
                            <div className="flex gap-1.5">
                              <Input
                                type="password"
                                placeholder="User token..."
                                value={campaign.token}
                                onChange={(e) => updateCampaign(campaign.id, { token: e.target.value, tokenValid: null })}
                                className="h-8 font-mono text-xs bg-input border-border focus-visible:ring-primary/50"
                                disabled={campaign.running}
                              />
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8 px-2.5 text-xs border-border hover:border-primary/40 shrink-0"
                                onClick={() => handleValidateCampaignToken(campaign.id, campaign.token)}
                                disabled={!campaign.token || validateTokenMutation.isPending || campaign.running}
                              >
                                {validateTokenMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Check"}
                              </Button>
                            </div>
                          </div>

                          {/* Channels */}
                          <div>
                            <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center justify-between">
                              Channel IDs
                              <span className="text-primary font-mono">{channels.length} ch</span>
                            </Label>
                            <Textarea
                              placeholder="One channel ID per line or comma separated..."
                              value={campaign.channelsInput}
                              onChange={(e) => updateCampaign(campaign.id, { channelsInput: e.target.value })}
                              className="min-h-[80px] font-mono text-xs resize-y bg-input border-border focus-visible:ring-primary/50"
                              disabled={campaign.running}
                            />
                          </div>

                          {/* Message */}
                          <div>
                            <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 block">
                              Message
                            </Label>
                            <Textarea
                              placeholder="Message to broadcast..."
                              value={campaign.message}
                              onChange={(e) => updateCampaign(campaign.id, { message: e.target.value })}
                              className="min-h-[80px] text-sm resize-y bg-input border-border focus-visible:ring-primary/50"
                              disabled={campaign.running}
                            />
                          </div>
                        </div>

                        {/* Right column */}
                        <div className="space-y-3 pt-4">
                          {/* Timing */}
                          <div className="rounded border border-border bg-background/30 p-3 space-y-3">
                            <div>
                              <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center gap-1.5">
                                <Clock className="w-3 h-3" /> Interval (seconds)
                              </Label>
                              <Input
                                type="number"
                                min="1"
                                value={campaign.delay}
                                onChange={(e) => updateCampaign(campaign.id, { delay: Math.max(1, Number(e.target.value)) })}
                                className="h-8 font-mono bg-input border-border focus-visible:ring-primary/50"
                                disabled={campaign.running}
                              />
                            </div>
                            <div>
                              <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center justify-between">
                                <span className="flex items-center gap-1.5"><Activity className="w-3 h-3" /> Jitter</span>
                                <span className="text-primary font-mono">{campaign.jitter}%</span>
                              </Label>
                              <Slider
                                min={0}
                                max={100}
                                step={5}
                                value={[campaign.jitter]}
                                onValueChange={([v]) => updateCampaign(campaign.id, { jitter: v })}
                                disabled={campaign.running}
                              />
                              <p className="text-[10px] text-muted-foreground mt-1.5">
                                Adds up to {campaign.jitter}% extra random delay per cycle
                              </p>
                            </div>
                          </div>

                          {/* Load Preset */}
                          <div>
                            <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 block">
                              Load Preset
                            </Label>
                            {sessionsLoading ? (
                              <div className="text-xs text-muted-foreground font-mono py-2">Loading...</div>
                            ) : sessions.length === 0 ? (
                              <div className="text-xs text-muted-foreground font-mono py-2 border border-dashed border-border/50 rounded text-center">
                                No presets saved
                              </div>
                            ) : (
                              <ScrollArea className="max-h-[140px]">
                                <div className="space-y-1.5">
                                  {sessions.map((s) => (
                                    <div key={s.id} className="flex items-center gap-2 px-2.5 py-1.5 rounded border border-border hover:border-primary/30 bg-background/40 group">
                                      <div className="flex-1 min-w-0">
                                        <div className="text-xs font-medium truncate">{s.name}</div>
                                        <div className="text-[10px] text-muted-foreground font-mono">{s.channels.length} ch · {s.delay}s</div>
                                      </div>
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-6 px-2 text-[11px] text-primary hover:bg-primary/10 shrink-0"
                                        onClick={() => handleLoadSession(s, campaign.id)}
                                        disabled={campaign.running}
                                      >
                                        Load
                                      </Button>
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-6 w-6 text-red-400 hover:bg-red-400/10 shrink-0"
                                        onClick={() => handleDeleteSession(s.id)}
                                      >
                                        <Trash2 className="w-3 h-3" />
                                      </Button>
                                    </div>
                                  ))}
                                </div>
                              </ScrollArea>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* === AI REPLY === */}
          {activeView === "ai-reply" && (
            <div className="max-w-5xl space-y-4">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="rounded border border-border bg-card/60 p-4 space-y-4">
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                    <Key className="w-3.5 h-3.5 text-primary" /> Token for AI Features
                  </h3>
                  <div>
                    <Label className="text-[10px] text-muted-foreground mb-1.5 block uppercase tracking-widest">Discord Token</Label>
                    <Input
                      type="password"
                      placeholder="Enter token to fetch DMs and auto-reply..."
                      value={aiToken}
                      onChange={(e) => setAiToken(e.target.value)}
                      className="font-mono text-sm bg-input border-border focus-visible:ring-primary/50"
                    />
                  </div>

                  <div>
                    <h4 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center gap-2">
                      <Cpu className="w-3 h-3 text-primary" /> AI Persona
                    </h4>
                    <Textarea
                      placeholder="e.g. You are a friendly gamer who loves anime. Keep replies casual and short..."
                      value={aiPersona}
                      onChange={(e) => setAiPersona(e.target.value)}
                      className="min-h-[80px] text-sm resize-y bg-input border-border focus-visible:ring-primary/50"
                    />
                  </div>

                  <div className="flex items-center justify-between pt-1">
                    <div>
                      <Label className="text-sm font-medium">Auto-Reply</Label>
                      <p className="text-[10px] text-muted-foreground">Reply to DMs automatically every 60s</p>
                    </div>
                    <Switch
                      checked={autoReplyEnabled}
                      onCheckedChange={(v) => {
                        if (v && !aiToken) { toast({ title: "No token set", description: "Enter a token first.", variant: "destructive" }); return; }
                        setAutoReplyEnabled(v);
                        addLog(v ? "Auto-reply enabled." : "Auto-reply disabled.", "info", "ai-reply");
                      }}
                    />
                  </div>
                  {autoReplyEnabled && (
                    <div className="flex items-center gap-2 text-xs text-green-400 bg-green-400/5 border border-green-400/20 rounded px-3 py-2">
                      <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                      Auto-reply active — scanning every 60s
                    </div>
                  )}
                </div>

                <div className="rounded border border-border bg-card/60 p-4 space-y-4">
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                    <MessageSquare className="w-3.5 h-3.5 text-primary" /> Manual AI Reply
                  </h3>
                  <div>
                    <Label className="text-[10px] text-muted-foreground mb-1.5 block uppercase tracking-widest">Message to Reply To</Label>
                    <Textarea
                      placeholder="Paste the message you received..."
                      value={aiContext}
                      onChange={(e) => setAiContext(e.target.value)}
                      className="min-h-[80px] text-sm resize-y bg-input border-border focus-visible:ring-primary/50"
                    />
                  </div>
                  <div>
                    <Label className="text-[10px] text-muted-foreground mb-1.5 block uppercase tracking-widest">Channel ID (optional — auto-send)</Label>
                    <Input
                      placeholder="Channel ID to send reply..."
                      value={aiChannelId}
                      onChange={(e) => setAiChannelId(e.target.value)}
                      className="font-mono text-sm bg-input border-border"
                    />
                  </div>
                  <Button
                    className="w-full bg-primary/80 hover:bg-primary"
                    onClick={() => handleGenerateAIReply(undefined, aiChannelId || undefined)}
                    disabled={!aiContext || generateAIReplyMutation.isPending}
                  >
                    {generateAIReplyMutation.isPending ? (
                      <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Generating...</>
                    ) : (
                      <><Bot className="w-4 h-4 mr-2" /> Generate Reply</>
                    )}
                  </Button>
                  {generatedReply && (
                    <div className="p-3 rounded border border-primary/20 bg-primary/5 text-sm text-foreground leading-relaxed">
                      <div className="text-[9px] uppercase tracking-widest text-primary mb-2">Generated Reply</div>
                      {generatedReply}
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded border border-border bg-card/60 p-4">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                    <MessageSquare className="w-3.5 h-3.5 text-primary" /> DM Conversations
                  </h3>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs border-border hover:border-primary/40"
                    onClick={handleFetchDMs}
                    disabled={!aiToken || fetchDMsMutation.isPending}
                  >
                    {fetchDMsMutation.isPending ? (
                      <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />Loading...</>
                    ) : (
                      <><RefreshCw className="w-3 h-3 mr-1.5" />Fetch DMs</>
                    )}
                  </Button>
                </div>
                {dms.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground text-xs font-mono border border-dashed border-border/50 rounded">
                    {aiToken ? "Click 'Fetch DMs' to load conversations" : "Set a token above first, then fetch DMs"}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {dms.map((dm) => (
                      <div key={dm.channelId} className="flex items-start gap-3 p-3 rounded border border-border hover:border-primary/30 bg-background/30 group transition-colors">
                        <Avatar className="w-8 h-8 border border-border shrink-0">
                          <AvatarImage src={dm.avatar ? `https://cdn.discordapp.com/avatars/${dm.userId}/${dm.avatar}.png` : undefined} />
                          <AvatarFallback className="bg-primary/20 text-primary text-xs font-bold">
                            {dm.username.charAt(0).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-sm font-medium">{dm.username}</span>
                            {dm.fromMe && <Badge variant="outline" className="text-[9px] border-primary/30 text-primary px-1 py-0">You</Badge>}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">{dm.lastMessage || "(no message)"}</div>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-[11px] text-primary hover:bg-primary/10 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                          onClick={() => {
                            setAiContext(dm.lastMessage);
                            setAiChannelId(dm.channelId);
                            handleGenerateAIReply(dm.lastMessage, dm.channelId);
                          }}
                          disabled={dm.fromMe || generateAIReplyMutation.isPending}
                        >
                          <Bot className="w-3 h-3 mr-1" />AI Reply
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* === TOKENS === */}
          {activeView === "tokens" && (
            <div className="max-w-2xl space-y-4">
              <div className="rounded border border-border bg-card/60 p-5 space-y-4">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                  <Key className="w-3.5 h-3.5 text-primary" /> Validate Discord Token
                </h3>
                <div className="flex gap-2">
                  <Input
                    type="password"
                    placeholder="Enter Discord user token..."
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    className="font-mono text-sm bg-input border-border focus-visible:ring-primary/50"
                  />
                  <Button
                    onClick={handleValidateToken}
                    disabled={!tokenInput || validateTokenMutation.isPending}
                    className="bg-primary/80 hover:bg-primary shrink-0"
                  >
                    {validateTokenMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Validate"}
                  </Button>
                </div>
                {tokenInfo?.valid && (
                  <div className="flex items-center gap-3 p-3 rounded border border-green-500/20 bg-green-500/5">
                    <Avatar className="w-10 h-10 border border-border">
                      <AvatarImage src={tokenInfo.avatar ? `https://cdn.discordapp.com/avatars/${tokenInfo.id}/${tokenInfo.avatar}.png` : undefined} />
                      <AvatarFallback className="bg-primary/20 text-primary font-bold">{tokenInfo.username?.charAt(0).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <div className="flex-1">
                      <div className="font-semibold text-sm">{tokenInfo.username}<span className="text-muted-foreground">#{tokenInfo.discriminator}</span></div>
                      <div className="text-xs text-muted-foreground font-mono">{tokenInfo.id}</div>
                    </div>
                    <Badge className="bg-green-500/10 text-green-400 border-green-500/20">Valid</Badge>
                  </div>
                )}
                {tokenInfo && !tokenInfo.valid && (
                  <div className="flex items-center gap-2 p-3 rounded border border-red-500/20 bg-red-500/5 text-red-400 text-sm">
                    <XCircle className="w-4 h-4 shrink-0" /> {tokenInfo.error || "Invalid token"}
                  </div>
                )}
              </div>

              <div className="rounded border border-border bg-card/60 p-4 space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">How to Get Your Token</h3>
                <div className="space-y-2 text-xs text-muted-foreground leading-relaxed">
                  <p>1. Open Discord in your browser (discord.com)</p>
                  <p>2. Press F12 to open DevTools and go to the Network tab</p>
                  <p>3. Send a message or interact with the app to trigger a request</p>
                  <p>4. Find a request to discord.com/api — check the Authorization header</p>
                  <p className="pt-1 text-amber-400/80">Warning: Never share your token. Treat it like a password.</p>
                </div>
              </div>
            </div>
          )}

          {/* === LOGS === */}
          {activeView === "logs" && (
            <div className="max-w-4xl">
              <div className="rounded border border-border bg-card/60 overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-background/40">
                  <div className="flex items-center gap-2">
                    <History className="w-3.5 h-3.5 text-primary" />
                    <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Activity Log</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="font-mono text-[10px]">{logs.length} events</Badge>
                    <Button size="sm" variant="ghost" className="h-6 text-xs text-muted-foreground hover:text-foreground px-2"
                      onClick={() => setLogs([])}>Clear</Button>
                  </div>
                </div>
                <ScrollArea className="h-[calc(100vh-220px)]">
                  {logs.length === 0 ? (
                    <div className="flex items-center justify-center h-48 text-muted-foreground font-mono text-xs">
                      No events logged yet...
                    </div>
                  ) : (
                    <div className="font-mono text-xs divide-y divide-border/40">
                      {logs.map((log) => (
                        <div key={log.id} className="flex items-start gap-3 px-4 py-2.5 hover:bg-secondary/20 transition-colors">
                          <span className="text-muted-foreground whitespace-nowrap shrink-0 pt-0.5">
                            {log.timestamp.toLocaleTimeString(undefined, { hour12: false })}
                          </span>
                          {log.type === "success" && <CheckCircle className="w-3.5 h-3.5 text-green-400 mt-0.5 shrink-0" />}
                          {log.type === "error" && <XCircle className="w-3.5 h-3.5 text-red-400 mt-0.5 shrink-0" />}
                          {log.type === "info" && <div className="w-3.5 h-3.5 mt-0.5 shrink-0 flex items-center justify-center"><div className="w-1.5 h-1.5 rounded-full bg-blue-400" /></div>}
                          <span className={`leading-relaxed ${log.type === "success" ? "text-green-300/90" : log.type === "error" ? "text-red-300/90" : "text-foreground/70"}`}>
                            {log.view && <span className="text-primary/60 mr-2">[{log.view}]</span>}
                            {log.message}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </div>
            </div>
          )}

        </main>
      </div>
    </div>
  );
}
