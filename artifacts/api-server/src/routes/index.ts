import { Router, type IRouter } from "express";
import healthRouter from "./health";
import discordRouter from "./discord";
import campaignsRouter from "./campaigns";
import userSettingsRouter from "./user-settings";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/discord", discordRouter);
router.use("/campaigns", campaignsRouter);
router.use("/user-settings", userSettingsRouter);

export default router;
