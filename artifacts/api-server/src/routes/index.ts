import { Router, type IRouter } from "express";
import healthRouter from "./health";
import discordRouter from "./discord";
import campaignsRouter from "./campaigns";
import userSettingsRouter from "./user-settings";
import authRouter from "./auth";
import aiReplyCampaignsRouter from "./ai-reply-campaigns";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
router.use("/discord", discordRouter);
router.use("/campaigns", campaignsRouter);
router.use("/ai-reply-campaigns", aiReplyCampaignsRouter);
router.use("/user-settings", userSettingsRouter);

export default router;
