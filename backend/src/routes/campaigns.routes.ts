import { Router } from 'express';
import { currentUser, requireAuth } from '../middleware/auth';
import { getCampaign, listCampaigns } from '../services/campaign.service';
import { cancelCampaign } from '../services/scheduler.service';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/errors';
import { uuidParamSchema } from './schemas';

export const campaignsRouter = Router();

campaignsRouter.use(requireAuth);

campaignsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json({ items: await listCampaigns(user.id) });
  }),
);

campaignsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = uuidParamSchema.parse(req.params);
    const user = currentUser(req);
    const campaign = await getCampaign(user.id, id);
    if (!campaign) throw ApiError.notFound('Campaign not found.');
    res.json(campaign);
  }),
);

/** Cancels every still-pending email in the campaign. */
campaignsRouter.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const { id } = uuidParamSchema.parse(req.params);
    const user = currentUser(req);
    res.json({ cancelled: await cancelCampaign(user.id, id) });
  }),
);
