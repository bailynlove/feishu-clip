const $ = (selector) => document.querySelector(selector);
$('#extension-id').textContent = chrome.runtime.id;
function message(payload) { return chrome.runtime.sendMessage(payload).then((response) => { if (!response?.ok) throw Object.assign(new Error(response?.error?.message || '操作失败'), response?.error); return response.result; }); }
function show(text, kind = 'info') { $('#status').textContent = text; $('#status').className = `status ${kind}`; }
$('#pair').addEventListener('click', async () => { try { await message({ type: 'PAIR', code: $('#code').value.trim() }); $('#code').value = ''; show('配对成功。长期凭据仅保存在扩展的可信上下文中。', 'success'); } catch (error) { show(`配对失败：${error.message}`, 'error'); } });
$('#save-target').addEventListener('click', async () => { try { const destination = { nodeToken: $('#token').value.trim(), spaceId: $('#space').value.trim() || undefined }; const result = await message({ type: 'SAVE_DESTINATION', destination }); show(`默认目标已保存：${result.destination.title}`, 'success'); } catch (error) { show(`目标验证失败：${error.message}`, 'error'); } });
chrome.storage.local.get(['destination']).then(({ destination }) => { if (destination) { $('#token').value = destination.nodeToken || ''; $('#space').value = destination.spaceId || ''; } });
