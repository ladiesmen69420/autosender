import React, { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useValidateToken,
  useSendMessages,
  useListSessions,
  useCreateSession,
  useDeleteSession,
  getListSessionsQueryKey,
} from "@workspace/api-client-react";
import type { TokenValidationResult } from "@workspace/api-client-react/src/generated/api.schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Play, Square, Save, Trash2, ShieldAlert, History, KeyRound, MessageSquare, Clock, Zap } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type LogEntry = {
  id: string;
  timestamp: Date;
  message: string;
  type: "info" | "success" | "error";
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

  // App State
  const [token, setToken] = useState("");
  const [tokenInfo, setTokenInfo] = useState<TokenValidationResult | null>(null);
  
  const [channelsInput, setChannelsInput] = useState("");
  const [message, setMessage] = useState("");
  const [delay, setDelay] = useState(15);
  const [repeatBypass, setRepeatBypass] = useState(false);
  
  const [sessionName, setSessionName] = useState("");

  // Running State
  const [running, setRunning] = useState(false);
  const [sentCount, setSentCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [nextSend, setNextSend] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  // Refs for auto-sender loop
  const runningRef = useRef(running);
  runningRef.current = running;

  const stateRef = useRef({ token, channelsInput, message, repeatBypass, delay });
  stateRef.current = { token, channelsInput, message, repeatBypass, delay };

  const addLog = (msg: string, type: "info" | "success" | "error") => {
    setLogs((prev) => [
      { id: Math.random().toString(36).substring(7), timestamp: new Date(), message: msg, type },
      ...prev,
    ].slice(0, 100)); // Keep last 100 logs
  };

  const handleValidateToken = async () => {
    if (!token) return;
    try {
      const result = await validateTokenMutation.mutateAsync({ data: { token } });
      if (result.valid) {
        setTokenInfo(result);
        addLog(`Token validated for ${result.username}#${result.discriminator}`, "success");
        toast({ title: "Token Validated", description: `Authenticated as ${result.username}` });
      } else {
        setTokenInfo(null);
        addLog(`Token validation failed: ${result.error}`, "error");
        toast({ title: "Validation Failed", description: result.error || "Invalid token", variant: "destructive" });
      }
    } catch (err) {
      setTokenInfo(null);
      addLog("Network error while validating token", "error");
      toast({ title: "Error", description: "Failed to connect to validation service.", variant: "destructive" });
    }
  };

  // Loop
  useEffect(() => {
    let timeoutId: NodeJS.Timeout;
    let intervalId: NodeJS.Timeout;

    const performSend = async () => {
      if (!runningRef.current) return;
      
      const { token, channelsInput, message, repeatBypass, delay } = stateRef.current;
      const channels = channelsInput.split(/[\n,]+/).map(c => c.trim()).filter(Boolean);
      
      if (!token || channels.length === 0 || !message) {
        addLog("Cannot send: Missing token, channels, or message.", "error");
        setRunning(false);
        return;
      }

      addLog(`Attempting send to ${channels.length} channels...`, "info");
      try {
        const res = await sendMessagesMutation.mutateAsync({ 
          data: { token, channels, message, repeatBypass } 
        });
        
        if (res.failed > 0) {
          addLog(`Send complete: ${res.sent} sent, ${res.failed} failed.`, "error");
        } else {
          addLog(`Successfully sent to ${res.sent} channels.`, "success");
        }
        
        setSentCount(c => c + res.sent);
        setFailedCount(c => c + res.failed);
      } catch (err: any) {
        addLog(`Error during send: ${err.message || 'Unknown error'}`, "error");
        setFailedCount(c => c + channels.length); // Assume all failed
      }

      if (runningRef.current) {
        setNextSend(Date.now() + delay * 1000);
        timeoutId = setTimeout(performSend, delay * 1000);
      }
    };

    if (running) {
      addLog("AutoSender started.", "info");
      performSend();
      
      intervalId = setInterval(() => {
        setNow(Date.now());
      }, 100);
    } else {
      if (nextSend !== null) {
        addLog("AutoSender stopped.", "info");
      }
      setNextSend(null);
    }

    return () => {
      clearTimeout(timeoutId);
      clearInterval(intervalId);
    };
  }, [running]);

  const handleSaveSession = async () => {
    if (!sessionName) {
      toast({ title: "Error", description: "Session name is required.", variant: "destructive" });
      return;
    }
    const channels = channelsInput.split(/[\n,]+/).map(c => c.trim()).filter(Boolean);
    try {
      await createSessionMutation.mutateAsync({
        data: { name: sessionName, token, channels, message, delay, repeatBypass }
      });
      toast({ title: "Session Saved", description: `Session "${sessionName}" saved successfully.` });
      setSessionName("");
      queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
    } catch (err) {
      toast({ title: "Error", description: "Failed to save session.", variant: "destructive" });
    }
  };

  const handleLoadSession = (session: any) => {
    setToken(session.token);
    setChannelsInput(session.channels.join("\n"));
    setMessage(session.message);
    setDelay(session.delay);
    setRepeatBypass(session.repeatBypass || false);
    setTokenInfo(null); // Force re-validation
    toast({ title: "Session Loaded", description: `Loaded configuration for "${session.name}".` });
    addLog(`Loaded session: ${session.name}`, "info");
  };

  const handleDeleteSession = async (id: number) => {
    try {
      await deleteSessionMutation.mutateAsync({ id });
      toast({ title: "Session Deleted", description: "Session removed from saved list." });
      queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
    } catch (err) {
      toast({ title: "Error", description: "Failed to delete session.", variant: "destructive" });
    }
  };

  const nextSendSeconds = nextSend ? Math.max(0, (nextSend - now) / 1000).toFixed(1) : "0.0";

  return (
    <div className="min-h-screen bg-background text-foreground font-sans flex flex-col md:flex-row overflow-hidden selection:bg-primary/30">
      
      {/* Main Content Area */}
      <div className="flex-1 flex flex-col h-screen overflow-y-auto">
        <header className="px-6 py-4 border-b border-border bg-card/50 backdrop-blur sticky top-0 z-10 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded bg-primary flex items-center justify-center shadow-[0_0_15px_rgba(88,101,242,0.4)]">
              <Zap className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="font-bold text-lg leading-tight tracking-tight">AutoSender</h1>
              <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider">Automated Broadcast Protocol</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="font-mono bg-background text-xs border-border">
              v1.0.4-stable
            </Badge>
          </div>
        </header>

        <main className="flex-1 p-6 max-w-5xl mx-auto w-full flex flex-col gap-6">
          <Alert variant="destructive" className="bg-destructive/10 border-destructive/20 text-destructive-foreground">
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle className="font-semibold tracking-wide uppercase text-xs">Terms of Service Warning</AlertTitle>
            <AlertDescription className="text-sm opacity-90">
              This application utilizes self-botting via user tokens. This strictly violates Discord's Terms of Service and may result in immediate account termination. Use at your own risk.
            </AlertDescription>
          </Alert>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            
            {/* Left Column: Config */}
            <div className="flex flex-col gap-6">
              
              <Card className="bg-card border-border shadow-md">
                <CardHeader className="pb-4">
                  <CardTitle className="text-base font-medium flex items-center gap-2">
                    <KeyRound className="w-4 h-4 text-primary" /> Token Authentication
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex space-x-2">
                    <Input
                      type="password"
                      placeholder="Enter Discord User Token"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      className="font-mono text-sm bg-input border-border focus-visible:ring-primary"
                      disabled={running}
                    />
                    <Button 
                      onClick={handleValidateToken} 
                      disabled={!token || validateTokenMutation.isPending || running}
                      variant="secondary"
                    >
                      {validateTokenMutation.isPending ? "..." : "Validate"}
                    </Button>
                  </div>
                  
                  {tokenInfo && tokenInfo.valid && (
                    <div className="flex items-center gap-3 p-3 rounded-md bg-background border border-border/50">
                      <Avatar className="w-10 h-10 border border-border">
                        <AvatarImage src={tokenInfo.avatar || undefined} />
                        <AvatarFallback className="bg-primary/20 text-primary font-bold">
                          {tokenInfo.username?.charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex flex-col">
                        <span className="text-sm font-semibold">{tokenInfo.username}<span className="text-muted-foreground">#{tokenInfo.discriminator}</span></span>
                        <span className="text-xs text-muted-foreground font-mono">{tokenInfo.id}</span>
                      </div>
                      <Badge className="ml-auto bg-green-500/10 text-green-500 hover:bg-green-500/20 border-green-500/20">Valid</Badge>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card className="bg-card border-border shadow-md flex-1">
                <CardHeader className="pb-4">
                  <CardTitle className="text-base font-medium flex items-center gap-2">
                    <MessageSquare className="w-4 h-4 text-primary" /> Broadcast Configuration
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div className="space-y-2">
                    <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex justify-between">
                      Target Channels
                      <span className="font-mono text-primary/80 lowercase">{channelsInput.split(/[\n,]+/).filter(Boolean).length} valid</span>
                    </Label>
                    <Textarea 
                      placeholder="Paste channel IDs here (one per line or comma separated)"
                      value={channelsInput}
                      onChange={(e) => setChannelsInput(e.target.value)}
                      className="min-h-[100px] font-mono text-xs resize-y bg-input border-border"
                      disabled={running}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Payload Message</Label>
                    <Textarea 
                      placeholder="Enter the message to broadcast..."
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      className="min-h-[120px] text-sm resize-y bg-input border-border"
                      disabled={running}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4 pt-2">
                    <div className="space-y-2">
                      <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                        <Clock className="w-3 h-3" /> Interval (s)
                      </Label>
                      <Input 
                        type="number" 
                        min="1" 
                        value={delay} 
                        onChange={(e) => setDelay(Number(e.target.value) || 1)}
                        className="font-mono bg-input border-border"
                        disabled={running}
                      />
                    </div>
                    
                    <div className="space-y-2 flex flex-col justify-end pb-2">
                      <div className="flex items-center space-x-2">
                        <Switch 
                          id="repeat-bypass" 
                          checked={repeatBypass} 
                          onCheckedChange={setRepeatBypass}
                          disabled={running}
                        />
                        <Label htmlFor="repeat-bypass" className="text-sm font-medium cursor-pointer">Repeat Bypass</Label>
                      </div>
                      <p className="text-[10px] text-muted-foreground leading-tight">Appends invisible variance to bypass duplicate filters.</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

            </div>

            {/* Right Column: Execution & Logs */}
            <div className="flex flex-col gap-6">
              
              <Card className="bg-card border-border shadow-md border-t-4 border-t-primary">
                <CardContent className="p-6 flex flex-col items-center justify-center space-y-6">
                  
                  <div className="flex w-full justify-between items-center px-4 py-3 bg-background rounded-md border border-border">
                    <div className="text-center">
                      <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold mb-1">Status</p>
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${running ? "bg-green-500 animate-pulse" : "bg-muted-foreground"}`}></span>
                        <span className="font-mono text-sm font-bold">{running ? "ACTIVE" : "IDLE"}</span>
                      </div>
                    </div>
                    <Separator orientation="vertical" className="h-10 bg-border" />
                    <div className="text-center">
                      <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold mb-1">Sent</p>
                      <span className="font-mono text-xl font-bold text-primary">{sentCount}</span>
                    </div>
                    <Separator orientation="vertical" className="h-10 bg-border" />
                    <div className="text-center">
                      <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold mb-1">Failed</p>
                      <span className="font-mono text-xl font-bold text-destructive">{failedCount}</span>
                    </div>
                  </div>

                  {running && nextSend !== null && (
                    <div className="w-full text-center space-y-1">
                      <p className="text-xs text-muted-foreground uppercase tracking-widest font-mono">Next payload in</p>
                      <p className="text-4xl font-mono font-light tracking-tighter">{nextSendSeconds}s</p>
                    </div>
                  )}

                  <Button 
                    size="lg" 
                    className={`w-full font-bold tracking-widest uppercase transition-all duration-300 ${
                      running 
                        ? "bg-destructive hover:bg-destructive/90 text-destructive-foreground shadow-[0_0_20px_rgba(220,38,38,0.3)]" 
                        : "bg-primary hover:bg-primary/90 text-primary-foreground shadow-[0_0_20px_rgba(88,101,242,0.3)]"
                    }`}
                    onClick={() => setRunning(!running)}
                    disabled={!token || !channelsInput || !message}
                  >
                    {running ? (
                      <><Square className="w-5 h-5 mr-2 fill-current" /> Terminate Process</>
                    ) : (
                      <><Play className="w-5 h-5 mr-2 fill-current" /> Initialize Sequence</>
                    )}
                  </Button>
                </CardContent>
              </Card>

              <Card className="bg-card border-border shadow-md flex-1 flex flex-col min-h-[300px]">
                <CardHeader className="py-3 px-4 border-b border-border bg-background/50 flex flex-row items-center justify-between">
                  <CardTitle className="text-xs font-semibold uppercase tracking-wider flex items-center gap-2">
                    <History className="w-3.5 h-3.5" /> Execution Log
                  </CardTitle>
                  <Badge variant="secondary" className="font-mono text-[10px] px-1.5 py-0 rounded bg-border">
                    {logs.length} events
                  </Badge>
                </CardHeader>
                <CardContent className="p-0 flex-1 overflow-hidden">
                  <ScrollArea className="h-[300px] w-full p-4 font-mono text-xs">
                    {logs.length === 0 ? (
                      <div className="h-full w-full flex items-center justify-center text-muted-foreground italic">
                        Awaiting initialization...
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {logs.map((log) => (
                          <div key={log.id} className="flex gap-3 leading-relaxed break-words">
                            <span className="text-muted-foreground whitespace-nowrap shrink-0">
                              [{log.timestamp.toLocaleTimeString(undefined, { hour12: false, fractionalSecondDigits: 1 })}]
                            </span>
                            <span className={`
                              ${log.type === "info" ? "text-blue-400" : ""}
                              ${log.type === "success" ? "text-green-400" : ""}
                              ${log.type === "error" ? "text-red-400" : ""}
                            `}>
                              {log.message}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </ScrollArea>
                </CardContent>
              </Card>

            </div>
          </div>
        </main>
      </div>

      {/* Sidebar: Saved Sessions */}
      <div className="w-full md:w-80 bg-sidebar border-l border-border flex flex-col shrink-0">
        <div className="p-4 border-b border-border">
          <h2 className="font-semibold text-sm uppercase tracking-wider text-sidebar-foreground flex items-center gap-2">
            <Save className="w-4 h-4" /> Saved Presets
          </h2>
        </div>
        
        <ScrollArea className="flex-1 p-4">
          {sessionsLoading ? (
            <div className="text-sm text-muted-foreground font-mono text-center mt-10">Loading presets...</div>
          ) : sessions.length === 0 ? (
            <div className="text-sm text-muted-foreground font-mono text-center mt-10 border border-dashed border-border/50 p-6 rounded-md">
              No presets found in database.
            </div>
          ) : (
            <div className="space-y-3">
              {sessions.map((session) => (
                <div key={session.id} className="group p-3 rounded-md bg-background border border-border hover:border-primary/50 transition-colors relative">
                  <div className="font-medium text-sm text-foreground mb-1">{session.name}</div>
                  <div className="text-xs text-muted-foreground font-mono flex flex-col gap-1 mb-3">
                    <span>Channels: {session.channels.length}</span>
                    <span className="truncate">Msg: {session.message.substring(0, 20)}...</span>
                  </div>
                  <div className="flex gap-2">
                    <Button 
                      size="sm" 
                      variant="secondary" 
                      className="w-full text-xs h-7 bg-primary/10 text-primary hover:bg-primary/20"
                      onClick={() => handleLoadSession(session)}
                      disabled={running}
                    >
                      Load Preset
                    </Button>
                    <Button 
                      size="icon" 
                      variant="ghost" 
                      className="h-7 w-7 text-destructive hover:bg-destructive/10 hover:text-destructive shrink-0"
                      onClick={() => handleDeleteSession(session.id)}
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>

        <div className="p-4 border-t border-border bg-background/50">
          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 block">Save Current State</Label>
          <div className="flex gap-2">
            <Input 
              placeholder="Preset name..." 
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              className="h-8 text-xs font-mono bg-input border-border"
              disabled={running}
            />
            <Button 
              size="sm" 
              className="h-8 px-3"
              onClick={handleSaveSession}
              disabled={!sessionName || !token || !message || running || createSessionMutation.isPending}
            >
              <Save className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </div>

    </div>
  );
}
