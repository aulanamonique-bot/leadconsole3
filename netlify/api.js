const { connectLambda, getStore } = require('@netlify/blobs');

const DEFAULT_ADMIN_NAME = process.env.ADMIN_NAME || 'Admin';
const DEFAULT_ADMIN_PIN = process.env.ADMIN_PIN || '0000';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json'
};

function json(statusCode, body){
  return { statusCode, headers, body: JSON.stringify(body) };
}

function normalizeUser(user){
  return {
    name: String(user?.name || '').trim(),
    pin: String(user?.pin ?? '').trim(),
    role: String(user?.role || 'csr').trim().toLowerCase() === 'manager' ? 'manager' : 'csr',
    active: String(user?.active || 'yes').trim().toLowerCase() === 'no' ? 'no' : 'yes'
  };
}

function publicUser(user){
  const u = normalizeUser(user);
  return { name: u.name, role: u.role, active: u.active };
}

async function readState(){
  const store = getStore('lead-console');
  const saved = await store.get('state', { type: 'json' });
  const state = saved && typeof saved === 'object' ? saved : {};
  if(!Array.isArray(state.leads)) state.leads = [];
  if(!Array.isArray(state.users) || state.users.length === 0){
    state.users = [{ name: DEFAULT_ADMIN_NAME, pin: DEFAULT_ADMIN_PIN, role: 'manager', active: 'yes' }];
    await store.setJSON('state', state);
  }
  state.users = state.users.map(normalizeUser).filter(u => u.name);
  return { store, state };
}

async function writeState(store, state){
  state.leads = Array.isArray(state.leads) ? state.leads : [];
  state.users = Array.isArray(state.users) ? state.users.map(normalizeUser).filter(u => u.name) : [];
  await store.setJSON('state', state);
}

function checkLogin(users, name, pin){
  const cleanName = String(name || '').trim().toLowerCase();
  const cleanPin = String(pin ?? '').trim();
  return users.find(u => u.active === 'yes' && u.name.toLowerCase() === cleanName && u.pin === cleanPin);
}

exports.handler = async (event) => {
  if(event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  try{
    connectLambda(event);
    const { store, state } = await readState();

    if(event.httpMethod === 'GET'){
      return json(200, { ok:true, leads: state.leads, users: state.users.filter(u => u.active === 'yes').map(publicUser) });
    }

    if(event.httpMethod !== 'POST') return json(405, { ok:false, error:'Method not allowed' });

    let payload = {};
    try{ payload = JSON.parse(event.body || '{}'); }
    catch(e){ return json(400, { ok:false, error:'Invalid JSON' }); }

    const action = String(payload.action || '');

    if(action === 'login'){
      const user = checkLogin(state.users, payload.name, payload.pin);
      if(!user) return json(401, { ok:false, error:'Invalid login' });
      return json(200, { ok:true, name:user.name, role:user.role });
    }

    if(action === 'getUsersForManager'){
      const user = checkLogin(state.users, payload.name, payload.pin);
      if(!user || user.role !== 'manager') return json(403, { ok:false, error:'Manager access required', users:[] });
      return json(200, { ok:true, users: state.users });
    }

    if(action === 'updateUsers'){
      const user = checkLogin(state.users, payload.name, payload.pin);
      if(!user || user.role !== 'manager') return json(403, { ok:false, error:'Manager access required' });
      const nextUsers = Array.isArray(payload.users) ? payload.users.map(normalizeUser).filter(u => u.name) : [];
      if(nextUsers.length === 0) return json(400, { ok:false, error:'At least one user required' });
      if(!nextUsers.some(u => u.role === 'manager' && u.active === 'yes')) return json(400, { ok:false, error:'Keep at least one active manager' });
      if(nextUsers.some(u => !u.pin)) return json(400, { ok:false, error:'Every user needs a PIN' });
      const seen = new Set();
      state.users = nextUsers.filter(u => {
        const key = u.name.toLowerCase();
        if(seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      await writeState(store, state);
      return json(200, { ok:true, users: state.users.map(publicUser) });
    }

    if(action === 'upsert'){
      const lead = payload.lead;
      if(!lead || !lead.id) return json(400, { ok:false, error:'Lead id required' });
      const idx = state.leads.findIndex(l => l.id === lead.id);
      if(idx >= 0) state.leads[idx] = lead;
      else state.leads.unshift(lead);
      await writeState(store, state);
      return json(200, { ok:true, lead });
    }

    if(action === 'delete'){
      const id = String(payload.id || '');
      state.leads = state.leads.filter(l => l.id !== id);
      await writeState(store, state);
      return json(200, { ok:true });
    }

    return json(400, { ok:false, error:'Unknown action' });
  } catch(err){
    console.error(err);
    return json(500, { ok:false, error:'Server error', detail: String(err && err.message ? err.message : err) });
  }
};
