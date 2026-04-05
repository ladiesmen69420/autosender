import { Router, type IRouter } from "express";
import healthRouter from "./health";
import discordRouter from "./discord";
import campaignsRouter from "./campaigns";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/discord", discordRouter);
router.use("/campaigns", campaignsRouter);

export default router;
