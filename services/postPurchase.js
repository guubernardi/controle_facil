// server/services/postPurchase.js
'use strict';

const FormData = require('form-data');
const { getAuthedAxios, getActiveUserId } = require('../mlClient');

function pickAccount(req) {
  // permite forçar via ?user_id=..., senão usa ativo
  return req.query.user_id || getActiveUserId();
}

async function getReturnsByClaim(req, claimId) {
  const userId = pickAccount(req);
  const ax = await getAuthedAxios(userId);
  const { data } = await ax.get(`/post-purchase/v2/claims/${claimId}/returns`);
  return data;
}

async function getReturnReviews(req, returnId) {
  const userId = pickAccount(req);
  const ax = await getAuthedAxios(userId);
  const { data } = await ax.get(`/post-purchase/v1/returns/${returnId}/reviews`);
  return data;
}

/** Body:
 *  - [] vazio  => review OK (todas as orders)
 *  - [{ order_id, reason_id, message?, attachments? }] => fail
 */
async function postReturnReview(req, returnId, body) {
  const userId = pickAccount(req);
  const ax = await getAuthedAxios(userId);
  const payload = (body && body.length) ? body : undefined;
  const { data } = await ax.post(
    `/post-purchase/v1/returns/${returnId}/return-review`,
    payload
  );
  return data;
}

async function getFailReasons(req, claimId, flow = 'seller_return_failed') {
  const userId = pickAccount(req);
  const ax = await getAuthedAxios(userId);
  const { data } = await ax.get(`/post-purchase/v1/returns/reasons`, {
    params: { flow, claim_id: claimId }
  });
  return data;
}

/** Upload de attachment para revisão FAIL (retorna { file_name }) */
async function uploadReturnAttachment(req, claimId, file) {
  const userId = pickAccount(req);
  const ax = await getAuthedAxios(userId);
  const fd = new FormData();
  fd.append('file', file.buffer, { filename: file.originalname });
  const { data } = await ax.post(
    `/post-purchase/v1/claims/${claimId}/returns/attachments`,
    fd,
    { headers: fd.getHeaders() }
  );
  return data;
}

async function getReturnCost(req, claimId, calculate_amount_usd = false) {
  const userId = pickAccount(req);
  const ax = await getAuthedAxios(userId);
  const { data } = await ax.get(
    `/post-purchase/v1/claims/${claimId}/charges/return-cost`,
    { params: { calculate_amount_usd } }
  );
  return data;
}

module.exports = {
  getReturnsByClaim,
  getReturnReviews,
  postReturnReview,
  getFailReasons,
  uploadReturnAttachment,
  getReturnCost
};
