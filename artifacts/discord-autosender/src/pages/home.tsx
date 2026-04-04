import React, { useState, useEffect, useRef } from "react";
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
  Play, Square, Save, Trash2, ShieldAlert, RefreshCw,
  Send, Activity, Clock, TrendingUp, MessageSquare,
  Cpu, Radio, AlertTriangle, CheckCircle, XCircle, Loader2,
} from "lucide-react";

type View = "dashboard" | "autosender" | "ai-reply" | "tokens" | "logs";

type LogEntry = {
  id: string;
  timestamp: Date;
  message: string;
  type: "info" | "success" | "error";
  view?: View;
};

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

  // Token state
  const [token, setToken] = useState("");
  const [tokenInfo, setTokenInfo] = useState<TokenValidationResult | null>(null);

  // AutoSender state
  const [channelsInput, setChannelsInput] = useState("");
  const [message, setMessage] = useState("");
  const [delay, setDelay] = useState(15);
  const [repeatBypass, setRepeatBypass] = useState(false);
  const [jitter, setJitter] = useState(0);
  const [sessionName, setSessionName] = useState("");

  // Running state
  const [running, setRunning] = useState(false);
  const [sentCount, setSentCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [nextSend, setNextSend] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  // AI Reply state
  const [aiContext, setAiContext] = useState("");
  const [aiPersona, setAiPersona] = useState("");
  const [aiChannelId, setAiChannelId] = useState("");
  const [generatedReply, setGeneratedReply] = useState("");
  const [dms, setDMs] = useState<DMConversation[]>([]);
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(false);
  const autoReplyRef = useRef(autoReplyEnabled);
  autoReplyRef.current = autoReplyEnabled;

  // Logs
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const runningRef = useRef(running);
  runningRef.current = running;
  const stateRef = useRef({ token, channelsInput, message, repeatBypass, delay, jitter });
  stateRef.current = { token, channelsInput, message, repeatBypass, delay, jitter };

  const addLog = (msg: string, type: "info" | "success" | "error", view?: View) => {
    setLogs((prev) => [
      { id: Math.random().toString(36).substring(7), timestamp: new Date(), message: msg, type, view },
      ...prev,
    ].slice(0, 200));
  };

  // Token validation
  const handleValidateToken = async () => {
    if (!token) return;
    try {
      const result = await validateTokenMutation.mutateAsync({ data: { token } });
      if (result.valid) {
        setTokenInfo(result);
        addLog(`Token validated: ${result.username}#${result.discriminator} (${result.id})`, "success", "tokens");
        toast({ title: "Token Valid", description: `Authenticated as ${result.username}` });
      } else {
        setTokenInfo(null);
        addLog(`Token rejected: ${result.error}`, "error", "tokens");
        toast({ title: "Invalid Token", description: result.error || "Token rejected", variant: "destructive" });
      }
    } catch {
      addLog("Network error validating token", "error", "tokens");
      toast({ title: "Error", description: "Failed to reach validation service.", variant: "destructive" });
    }
  };

  // AutoSender loop
  useEffect(() => {
    let timeoutId: NodeJS.Timeout;
    let intervalId: NodeJS.Timeout;

    const performSend = async () => {
      if (!runningRef.current) return;
      const { token, channelsInput, message, repeatBypass, delay, jitter } = stateRef.current;
      const channels = channelsInput.split(/[\n,]+/).map((c) => c.trim()).filter(Boolean);
      if (!token || channels.length === 0 || !message) {
        addLog("Cannot send: Missing token, channels, or message.", "error", "autosender");
        setRunning(false);
        return;
      }
      addLog(`Sending to ${channels.length} channel(s)...`, "info", "autosender");
      try {
        const res = await sendMessagesMutation.mutateAsync({ data: { token, channels, message, repeatBypass } });
        setSentCount((c) => c + res.sent);
        setFailedCount((c) => c + res.failed);
        if (res.failed > 0) addLog(`Sent ${res.sent}, failed ${res.failed}.`, "error", "autosender");
        else addLog(`Delivered to ${res.sent} channel(s).`, "success", "autosender");
      } catch (err: any) {
        addLog(`Send error: ${err.message ?? "Unknown"}`, "error", "autosender");
        setFailedCount((c) => c + channels.length);
      }

      if (runningRef.current) {
        const jitterMs = jitter > 0 ? (delay * 1000 * (Math.random() * jitter)) / 100 : 0;
        const totalDelay = delay * 1000 + jitterMs;
        setNextSend(Date.now() + totalDelay);
        timeoutId = setTimeout(performSend, totalDelay);
      }
    };

    if (running) {
      addLog("AutoSender initialized.", "info", "autosender");
      performSend();
      intervalId = setInterval(() => setNow(Date.now()), 100);
    } else {
      setNextSend(null);
    }

    return () => { clearTimeout(timeoutId); clearInterval(intervalId); };
  }, [running]);

  // Auto-reply loop
  useEffect(() => {
    if (!autoReplyEnabled || !token) return;
    let intervalId: NodeJS.Timeout;

    const runAutoReply = async () => {
      if (!autoReplyRef.current) return;
      addLog("Running AI auto-reply scan...", "info", "ai-reply");
      try {
        const res = await runAutoReplyMutation.mutateAsync({ data: { token, persona: aiPersona || undefined } });
        if (res.replied > 0)
          addLog(`Auto-replied to ${res.replied} DM(s), skipped ${res.skipped}.`, "success", "ai-reply");
        else
          addLog(`Auto-reply scan: ${res.skipped} DMs skipped (already replied or empty).`, "info", "ai-reply");
      } catch {
        addLog("Auto-reply error.", "error", "ai-reply");
      }
    };

    runAutoReply();
    intervalId = setInterval(runAutoReply, 60000);
    return () => clearInterval(intervalId);
  }, [autoReplyEnabled, token]);

  const handleSaveSession = async () => {
    if (!sessionName) return;
    const channels = channelsInput.split(/[\n,]+/).map((c) => c.trim()).filter(Boolean);
    try {
      await createSessionMutation.mutateAsync({
        data: { name: sessionName, token, channels, message, delay, repeatBypass, jitter },
      });
      toast({ title: "Preset Saved", description: `"${sessionName}" saved.` });
      setSessionName("");
      queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
      addLog(`Preset saved: ${sessionName}`, "success", "autosender");
    } catch {
      toast({ title: "Error", description: "Failed to save preset.", variant: "destructive" });
    }
  };

  const handleLoadSession = (session: any) => {
    setToken(session.token);
    setChannelsInput(session.channels.join("\n"));
    setMessage(session.message);
    setDelay(session.delay);
    setRepeatBypass(session.repeatBypass || false);
    setJitter(session.jitter || 0);
    setTokenInfo(null);
    addLog(`Loaded preset: ${session.name}`, "info", "autosender");
    toast({ title: "Preset Loaded", description: session.name });
  };

  const handleDeleteSession = async (id: number) => {
    try {
      await deleteSessionMutation.mutateAsync({ id });
      queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
      addLog("Preset deleted.", "info");
    } catch {
      toast({ title: "Error", description: "Failed to delete preset.", variant: "destructive" });
    }
  };

  const handleFetchDMs = async () => {
    if (!token) return;
    try {
      const result = await fetchDMsMutation.mutateAsync({ data: { token } });
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
          token: channelOverride ? token : undefined,
          channelId: channelOverride,
        },
      });
      setGeneratedReply(res.reply);
      addLog(`AI reply generated${res.sent ? " and sent" : ""}.`, "success", "ai-reply");
      if (res.sent) toast({ title: "Reply Sent", description: "AI reply delivered." });
    } catch {
      addLog("AI reply generation failed.", "error", "ai-reply");
      toast({ title: "Error", description: "Failed to generate reply.", variant: "destructive" });
    }
  };

  const nextSendSeconds = nextSend ? Math.max(0, (nextSend - now) / 1000).toFixed(1) : "0.0";
  const channels = channelsInput.split(/[\n,]+/).filter(Boolean);
  const successRate = sentCount + failedCount > 0
    ? ((sentCount / (sentCount + failedCount)) * 100).toFixed(1)
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
        {/* Logo */}
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

        {/* Nav */}
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
              {activeView === item.id && (
                <ChevronRight className="w-3 h-3 ml-auto text-primary" />
              )}
            </button>
          ))}
        </nav>

        {/* Status */}
        <div className="px-4 py-3 border-t border-sidebar-border">
          <div className="flex items-center gap-2 mb-1">
            <div className={`w-1.5 h-1.5 rounded-full ${running ? "bg-green-400 animate-pulse" : tokenInfo?.valid ? "bg-primary" : "bg-muted-foreground"}`} />
            <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">
              {running ? "Broadcasting" : tokenInfo?.valid ? "Authenticated" : "Offline"}
            </span>
          </div>
          {tokenInfo?.valid && (
            <div className="text-[11px] text-foreground/70 truncate">{tokenInfo.username}</div>
          )}
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top bar */}
        <header className="border-b border-border bg-card/40 px-6 py-3.5 flex items-center justify-between shrink-0">
          <div>
            <h1 className="text-base font-semibold text-foreground capitalize">
              {activeView === "ai-reply" ? "AI Reply" : activeView}
            </h1>
            <p className="text-xs text-muted-foreground">
              {activeView === "dashboard" && "Your Discord automation command center"}
              {activeView === "autosender" && "Automated message broadcast engine"}
              {activeView === "ai-reply" && "Generate natural, context-aware DM replies"}
              {activeView === "tokens" && "Manage and validate Discord user tokens"}
              {activeView === "logs" && "Real-time activity and event log"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {running && (
              <Badge className="bg-green-500/10 text-green-400 border-green-500/20 font-mono text-[10px] animate-pulse">
                LIVE
              </Badge>
            )}
            <Badge variant="outline" className="font-mono text-[10px] border-border text-muted-foreground">
              {logs.length} events
            </Badge>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-y-auto p-6">

          {/* === DASHBOARD === */}
          {activeView === "dashboard" && (
            <div className="space-y-6 max-w-5xl">
              {/* Warning */}
              <div className="flex items-start gap-3 p-3 rounded border border-amber-500/20 bg-amber-500/5 text-amber-400/90">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <p className="text-xs leading-relaxed">
                  Self-botting via user tokens violates Discord's Terms of Service and may result in permanent account termination. Use at your own risk.
                </p>
              </div>

              {/* Stats */}
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                {[
                  { label: "Presets", value: sessions.length, icon: <Save className="w-4 h-4" />, sub: "Saved configs", color: "text-primary" },
                  { label: "Tokens", value: tokenInfo?.valid ? 1 : 0, icon: <Key className="w-4 h-4" />, sub: tokenInfo?.valid ? "Active" : "None set", color: "text-cyan-400" },
                  { label: "Channels", value: channels.length, icon: <MessageSquare className="w-4 h-4" />, sub: `${channels.length} targeted`, color: "text-violet-300" },
                  { label: "Messages Sent", value: sentCount, icon: <Activity className="w-4 h-4" />, sub: "All time total", color: "text-green-400" },
                  { label: "Success Rate", value: `${successRate}%`, icon: <TrendingUp className="w-4 h-4" />, sub: sentCount + failedCount > 0 ? "Excellent" : "No data", color: sentCount + failedCount > 0 && failedCount === 0 ? "text-green-400" : "text-amber-400" },
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

              {/* Quick Actions + Recent Logs */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="rounded border border-border bg-card/60 p-4">
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-2">
                    <Zap className="w-3.5 h-3.5 text-primary" /> Quick Actions
                  </h3>
                  <div className="space-y-1.5">
                    {[
                      { label: "Set up a token", onClick: () => setActiveView("tokens"), icon: <Key className="w-3.5 h-3.5" /> },
                      { label: "Configure AutoSender", onClick: () => setActiveView("autosender"), icon: <Radio className="w-3.5 h-3.5" /> },
                      { label: "Generate AI Reply", onClick: () => setActiveView("ai-reply"), icon: <Bot className="w-3.5 h-3.5" /> },
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
                    <Activity className="w-3.5 h-3.5 text-primary" /> Recent Activity
                  </h3>
                  {logs.length === 0 ? (
                    <div className="text-center py-6 text-muted-foreground text-xs font-mono">
                      No events yet. Start sending to see activity.
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {logs.slice(0, 6).map((log) => (
                        <div key={log.id} className="flex items-start gap-2 text-xs">
                          {log.type === "success" && <CheckCircle className="w-3 h-3 text-green-400 mt-0.5 shrink-0" />}
                          {log.type === "error" && <XCircle className="w-3 h-3 text-red-400 mt-0.5 shrink-0" />}
                          {log.type === "info" && <div className="w-3 h-3 mt-0.5 shrink-0 flex items-center justify-center"><div className="w-1.5 h-1.5 rounded-full bg-blue-400" /></div>}
                          <span className="text-foreground/70 leading-relaxed">{log.message}</span>
                          <span className="ml-auto text-muted-foreground whitespace-nowrap font-mono shrink-0">
                            {log.timestamp.toLocaleTimeString(undefined, { hour12: false })}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* === AUTOSENDER === */}
          {activeView === "autosender" && (
            <div className="max-w-5xl space-y-4">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Left: Config */}
                <div className="space-y-4">
                  {/* Channels */}
                  <div className="rounded border border-border bg-card/60 p-4">
                    <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground flex items-center justify-between mb-2">
                      Target Channels
                      <span className="text-primary font-mono">{channels.length} valid</span>
                    </Label>
                    <Textarea
                      placeholder="Channel IDs — one per line or comma separated"
                      value={channelsInput}
                      onChange={(e) => setChannelsInput(e.target.value)}
                      className="min-h-[90px] font-mono text-xs resize-y bg-input border-border focus-visible:ring-primary/50"
                      disabled={running}
                    />
                  </div>

                  {/* Message */}
                  <div className="rounded border border-border bg-card/60 p-4">
                    <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2 block">
                      Payload Message
                    </Label>
                    <Textarea
                      placeholder="Enter message to broadcast..."
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      className="min-h-[100px] text-sm resize-y bg-input border-border focus-visible:ring-primary/50"
                      disabled={running}
                    />
                  </div>

                  {/* Timing Options */}
                  <div className="rounded border border-border bg-card/60 p-4 space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2 flex items-center gap-1.5">
                          <Clock className="w-3 h-3" /> Interval (s)
                        </Label>
                        <Input
                          type="number" min="1"
                          value={delay}
                          onChange={(e) => setDelay(Math.max(1, Number(e.target.value)))}
                          className="font-mono bg-input border-border focus-visible:ring-primary/50"
                          disabled={running}
                        />
                      </div>
                      <div>
                        <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2 flex items-center gap-1.5">
                          <Activity className="w-3 h-3" /> Jitter ({jitter}%)
                        </Label>
                        <Slider
                          min={0} max={100} step={5}
                          value={[jitter]}
                          onValueChange={([v]) => setJitter(v)}
                          disabled={running}
                          className="mt-3"
                        />
                        <p className="text-[10px] text-muted-foreground mt-1.5">
                          Adds up to {jitter}% extra random delay
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-1">
                      <div>
                        <Label htmlFor="repeat-bypass" className="text-sm font-medium cursor-pointer">Repeat Bypass</Label>
                        <p className="text-[10px] text-muted-foreground">Appends variance to avoid duplicate filters</p>
                      </div>
                      <Switch
                        id="repeat-bypass"
                        checked={repeatBypass}
                        onCheckedChange={setRepeatBypass}
                        disabled={running}
                      />
                    </div>
                  </div>
                </div>

                {/* Right: Control + Presets */}
                <div className="space-y-4">
                  {/* Control Panel */}
                  <div className="rounded border border-primary/20 bg-primary/5 p-5 space-y-5">
                    {/* Stats row */}
                    <div className="grid grid-cols-3 gap-3">
                      {[
                        { label: "Status", value: running ? "ACTIVE" : "IDLE", color: running ? "text-green-400" : "text-muted-foreground" },
                        { label: "Sent", value: sentCount, color: "text-primary" },
                        { label: "Failed", value: failedCount, color: failedCount > 0 ? "text-red-400" : "text-muted-foreground" },
                      ].map((s) => (
                        <div key={s.label} className="text-center py-2 rounded border border-border bg-card/60">
                          <div className="text-[9px] uppercase tracking-widest text-muted-foreground mb-1">{s.label}</div>
                          <div className={`font-mono font-bold text-lg ${s.color} flex items-center justify-center gap-1`}>
                            {s.label === "Status" && running && <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />}
                            {s.value}
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Countdown */}
                    {running && nextSend !== null && (
                      <div className="text-center">
                        <div className="text-[10px] text-muted-foreground uppercase tracking-widest font-mono mb-1">Next send in</div>
                        <div className="text-3xl font-mono font-light text-primary glow-text-primary">{nextSendSeconds}s</div>
                      </div>
                    )}

                    {/* Start/Stop */}
                    <Button
                      size="lg"
                      className={`w-full font-bold tracking-widest uppercase ${
                        running
                          ? "bg-red-600/80 hover:bg-red-600 border-red-500/20 text-white shadow-[0_0_20px_rgba(220,38,38,0.3)]"
                          : "bg-primary hover:bg-primary/90 text-white shadow-[0_0_20px_rgba(124,58,237,0.3)]"
                      }`}
                      onClick={() => setRunning(!running)}
                      disabled={!token || !channelsInput || !message}
                    >
                      {running ? (
                        <><Square className="w-4 h-4 mr-2 fill-current" /> Terminate</>
                      ) : (
                        <><Play className="w-4 h-4 mr-2 fill-current" /> Initialize</>
                      )}
                    </Button>

                    {(!token || !channelsInput || !message) && !running && (
                      <p className="text-[10px] text-center text-muted-foreground">
                        Set token, channels, and message to start
                      </p>
                    )}
                  </div>

                  {/* Save Preset */}
                  <div className="rounded border border-border bg-card/60 p-4">
                    <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2 block">
                      Save Preset
                    </Label>
                    <div className="flex gap-2">
                      <Input
                        placeholder="Preset name..."
                        value={sessionName}
                        onChange={(e) => setSessionName(e.target.value)}
                        className="h-8 text-sm font-mono bg-input border-border"
                        disabled={running}
                      />
                      <Button
                        size="sm"
                        className="h-8 px-3 bg-primary/80 hover:bg-primary"
                        onClick={handleSaveSession}
                        disabled={!sessionName || !token || !message || running}
                      >
                        <Save className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>

                  {/* Presets */}
                  <div className="rounded border border-border bg-card/60 p-4">
                    <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-3 block">
                      Saved Presets
                    </Label>
                    {sessionsLoading ? (
                      <div className="text-xs text-muted-foreground font-mono text-center py-3">Loading...</div>
                    ) : sessions.length === 0 ? (
                      <div className="text-xs text-muted-foreground font-mono text-center py-3 border border-dashed border-border/50 rounded">
                        No presets saved yet
                      </div>
                    ) : (
                      <ScrollArea className="max-h-48">
                        <div className="space-y-2">
                          {sessions.map((s) => (
                            <div key={s.id} className="flex items-center gap-2 p-2.5 rounded border border-border hover:border-primary/30 bg-background/40 group">
                              <div className="flex-1 min-w-0">
                                <div className="text-xs font-medium truncate">{s.name}</div>
                                <div className="text-[10px] text-muted-foreground font-mono">{s.channels.length} ch · {s.delay}s</div>
                              </div>
                              <Button size="sm" variant="ghost" className="h-7 px-2 text-primary hover:bg-primary/10 text-xs shrink-0"
                                onClick={() => handleLoadSession(s)} disabled={running}>Load</Button>
                              <Button size="icon" variant="ghost" className="h-7 w-7 text-red-400 hover:bg-red-400/10 shrink-0"
                                onClick={() => handleDeleteSession(s.id)}>
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
            </div>
          )}

          {/* === AI REPLY === */}
          {activeView === "ai-reply" && (
            <div className="max-w-5xl space-y-4">
              {/* AI Persona + Auto-Reply header */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Persona Settings */}
                <div className="rounded border border-border bg-card/60 p-4 space-y-4">
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                    <Cpu className="w-3.5 h-3.5 text-primary" /> AI Persona
                  </h3>
                  <div>
                    <Label className="text-[10px] text-muted-foreground mb-1.5 block uppercase tracking-widest">
                      Character Instructions
                    </Label>
                    <Textarea
                      placeholder="e.g. You are a friendly gamer who loves anime. Keep replies casual and short..."
                      value={aiPersona}
                      onChange={(e) => setAiPersona(e.target.value)}
                      className="min-h-[90px] text-sm resize-y bg-input border-border focus-visible:ring-primary/50"
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
                        if (v && !token) { toast({ title: "No token set", description: "Set a token first.", variant: "destructive" }); return; }
                        setAutoReplyEnabled(v);
                        addLog(v ? "Auto-reply enabled." : "Auto-reply disabled.", "info", "ai-reply");
                      }}
                    />
                  </div>
                  {autoReplyEnabled && (
                    <div className="flex items-center gap-2 text-xs text-green-400 bg-green-400/5 border border-green-400/20 rounded px-3 py-2">
                      <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                      Auto-reply is active — scanning every 60s
                    </div>
                  )}
                </div>

                {/* Manual AI Reply */}
                <div className="rounded border border-border bg-card/60 p-4 space-y-4">
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                    <MessageSquare className="w-3.5 h-3.5 text-primary" /> AI Conversation
                  </h3>
                  <div>
                    <Label className="text-[10px] text-muted-foreground mb-1.5 block uppercase tracking-widest">
                      Message to Reply To
                    </Label>
                    <Textarea
                      placeholder="Paste the message you received..."
                      value={aiContext}
                      onChange={(e) => setAiContext(e.target.value)}
                      className="min-h-[70px] text-sm resize-y bg-input border-border focus-visible:ring-primary/50"
                    />
                  </div>
                  <div>
                    <Label className="text-[10px] text-muted-foreground mb-1.5 block uppercase tracking-widest">
                      Channel ID (optional — auto-send)
                    </Label>
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

              {/* DM Conversations */}
              <div className="rounded border border-border bg-card/60 p-4">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                    <MessageSquare className="w-3.5 h-3.5 text-primary" /> DM Conversations
                  </h3>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs border-border hover:border-primary/40 hover:bg-primary/5"
                    onClick={handleFetchDMs}
                    disabled={!token || fetchDMsMutation.isPending}
                  >
                    {fetchDMsMutation.isPending ? (
                      <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> Loading...</>
                    ) : (
                      <><RefreshCw className="w-3 h-3 mr-1.5" /> Fetch DMs</>
                    )}
                  </Button>
                </div>

                {dms.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground text-xs font-mono border border-dashed border-border/50 rounded">
                    {token ? "Click 'Fetch DMs' to load conversations" : "Set a token first, then fetch DMs"}
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
                          <Bot className="w-3 h-3 mr-1" />
                          AI Reply
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
                  <Key className="w-3.5 h-3.5 text-primary" /> Discord User Token
                </h3>

                <div className="flex gap-2">
                  <Input
                    type="password"
                    placeholder="Enter Discord user token..."
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    className="font-mono text-sm bg-input border-border focus-visible:ring-primary/50"
                  />
                  <Button
                    onClick={handleValidateToken}
                    disabled={!token || validateTokenMutation.isPending}
                    className="bg-primary/80 hover:bg-primary shrink-0"
                  >
                    {validateTokenMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Validate"}
                  </Button>
                </div>

                {tokenInfo && tokenInfo.valid && (
                  <div className="flex items-center gap-3 p-3 rounded border border-green-500/20 bg-green-500/5">
                    <Avatar className="w-10 h-10 border border-border">
                      <AvatarImage src={tokenInfo.avatar ? `https://cdn.discordapp.com/avatars/${tokenInfo.id}/${tokenInfo.avatar}.png` : undefined} />
                      <AvatarFallback className="bg-primary/20 text-primary font-bold">
                        {tokenInfo.username?.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1">
                      <div className="font-semibold text-sm text-foreground">{tokenInfo.username}<span className="text-muted-foreground">#{tokenInfo.discriminator}</span></div>
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

              {/* Info */}
              <div className="rounded border border-border bg-card/60 p-4 space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">How to Get Your Token</h3>
                <div className="space-y-2 text-xs text-muted-foreground leading-relaxed">
                  <p>1. Open Discord in your browser (discord.com)</p>
                  <p>2. Open DevTools (F12) and go to the Network tab</p>
                  <p>3. Send any message or reload the page</p>
                  <p>4. Look for a request to discord.com/api/v9 — check the Authorization header</p>
                  <p className="pt-1 text-amber-400/80">Warning: Never share your token with anyone. Treat it like a password.</p>
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
                        <div key={log.id} className={`flex items-start gap-3 px-4 py-2.5 hover:bg-secondary/20 transition-colors`}>
                          <span className="text-muted-foreground whitespace-nowrap shrink-0 pt-0.5">
                            {log.timestamp.toLocaleTimeString(undefined, { hour12: false, fractionalSecondDigits: 1 })}
                          </span>
                          {log.type === "success" && <CheckCircle className="w-3.5 h-3.5 text-green-400 mt-0.5 shrink-0" />}
                          {log.type === "error" && <XCircle className="w-3.5 h-3.5 text-red-400 mt-0.5 shrink-0" />}
                          {log.type === "info" && <div className="w-3.5 h-3.5 mt-0.5 shrink-0 flex items-center justify-center"><div className="w-1.5 h-1.5 rounded-full bg-blue-400" /></div>}
                          <span className={`leading-relaxed ${
                            log.type === "success" ? "text-green-300/90" :
                            log.type === "error" ? "text-red-300/90" :
                            "text-foreground/70"
                          }`}>
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
