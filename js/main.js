$(document).ready(function() {
    const $scoreContainer = $('#score-container');
    const $addStaffBtn = $('#add-staff');
    const $removeStaffBtn = $('#remove-staff');
    const $appScaler = $('#app-scaler');
    
    let staffCount = 1;
    let currentScale = 1;

    // --- 웹 오디오 엔진 (Web Audio API 기반 AudioManager) ---
    class AudioManager {
        constructor() {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
            this.buffers = {};
            this.isLoaded = false;
            this.baseUrl = 'media/audio/';
            this.pitchNames = [
                '라5', '솔5', '파5', '미5', '레5', '도5', '시4', '라4', '솔4', '파4', '미4', '레4', '도4', '시3', '라3'
            ];
            this.durationNames = [
                '16분', '8분', '점8분', '4분', '점4분', '2분', '점2분', '온'
            ];
            this.activeSources = [];
        }

        getNoteFileName(toolId, pitchIndex) {
            const prefix = (parseInt(toolId) + 1).toString().padStart(2, '0');
            const pitchSuffix = (17 - pitchIndex).toString().padStart(2, '0');
            const durationName = this.durationNames[toolId];
            const pitchName = this.pitchNames[pitchIndex];
            return `notes/note_${toolId}/${prefix}-${pitchSuffix}_${durationName}-${pitchName}.wav`;
        }

        getRestFileName(toolId) {
            const durationName = this.durationNames[toolId];
            return `mute/${durationName}쉼표.wav`;
        }

        loadSound(url) {
            if (this.buffers[url]) return Promise.resolve(this.buffers[url]);
            const self = this;
            return fetch(this.baseUrl + url)
                .then(function(response) { return response.arrayBuffer(); })
                .then(function(arrayBuffer) { return self.ctx.decodeAudioData(arrayBuffer); })
                .then(function(audioBuffer) {
                    self.buffers[url] = audioBuffer;
                    return audioBuffer;
                })
                .catch(function(e) {
                    console.warn('Failed to load sound: ' + url, e);
                    return null;
                });
        }

        async preloadAll() {
            const urls = ['button.mp3'];
            for (let t = 0; t < 8; t++) {
                for (let p = 0; p < 15; p++) urls.push(this.getNoteFileName(t, p));
                urls.push(this.getRestFileName(t));
            }
            const self = this;
            const promises = urls.map(function(url) { return self.loadSound(url); });
            await Promise.all(promises);
            this.isLoaded = true;
            
            // 로딩 완료 후 시작 버튼 활성화
            $('#loading-text').text('모든 리소스를 불러왔습니다.');
            $('.spinner').hide();
            $('#start-app-btn').show();
        }

        scheduleBuffer(url, time) {
            const buffer = this.buffers[url];
            if (!buffer) return null;
            const source = this.ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(this.ctx.destination);
            source.start(time);
            this.activeSources.push(source);
            const self = this;
            source.onended = function() {
                const idx = self.activeSources.indexOf(source);
                if (idx > -1) self.activeSources.splice(idx, 1);
            };
            return source;
        }

        playImmediately(url) {
            if (this.ctx.state === 'suspended') this.ctx.resume();
            this.scheduleBuffer(url, this.ctx.currentTime);
        }

        stopAll() {
            this.activeSources.forEach(function(source) { try { source.stop(); } catch(e) {} });
            this.activeSources = [];
        }
    }

    const audioMgr = new AudioManager();
    audioMgr.preloadAll();

    // 시작 버튼 클릭 핸들러
    $('#start-app-btn').on('click', function() {
        if (audioMgr.ctx.state === 'suspended') audioMgr.ctx.resume();
        $('#loading-overlay').css('opacity', '0');
        setTimeout(function() { $('#loading-overlay').hide(); }, 500);
    });

    // --- 재생 관리 로직 (AudioContext Scheduler 기반) ---
    let isPlaying = false;
    let schedulerTimer = null;
    let uiAnimationId = null;
    let nextNoteTime = 0;
    const lookahead = 0.1;
    const scheduleInterval = 25;
    let currentBeat = 0;
    let scheduledEvents = [];
    let playbackEndTime = 0;
    let currentBPM = 100;

    $('#tempo-slider').on('input', function() {
        currentBPM = parseInt($(this).val());
        $('#bpm-value').text(currentBPM);
    });

    function stopPlayback() {
        isPlaying = false;
        if (schedulerTimer) {
            clearInterval(schedulerTimer);
            schedulerTimer = null;
        }
        cancelAnimationFrame(uiAnimationId);
        audioMgr.stopAll();
        $('.placed-note').removeClass('playing-note');
        $('#play-btn').html('<i class="fa-solid fa-play"></i>').removeClass('active');
        scheduledEvents = [];
    }

    function startPlayback() {
        if (isPlaying) return;
        if (audioMgr.ctx.state === 'suspended') audioMgr.ctx.resume();
        isPlaying = true;
        $('#play-btn').html('<i class="fa-solid fa-pause"></i>').addClass('active');

        const staffs = [];
        let maxDuration = 0;
        $('.staff-wrapper').each(function() {
            const staffNotes = [];
            $(this).find('.measure').each(function(mIdx) {
                const notes = $(this).data('notes') || [];
                notes.forEach((n, i) => { n.measureIdx = mIdx; n.noteIdx = i; });
                staffNotes.push(...notes);
            });
            staffs.push(staffNotes);
            
            let staffDuration = 0;
            staffNotes.forEach(n => staffDuration += n.beat);
            if (staffDuration > maxDuration) maxDuration = staffDuration;
        });

        const secondsPerBeat = 60 / currentBPM;
        nextNoteTime = audioMgr.ctx.currentTime + 0.1;
        currentBeat = 0;
        scheduledEvents = [];
        playbackEndTime = nextNoteTime;

        schedulerTimer = setInterval(function() {
            while (nextNoteTime < audioMgr.ctx.currentTime + lookahead) {
                if (currentBeat >= maxDuration) {
                    clearInterval(schedulerTimer);
                    schedulerTimer = null;
                    return;
                }
                scheduleTick(nextNoteTime, secondsPerBeat, staffs, maxDuration);
                nextNoteTime += 0.25 * secondsPerBeat;
                currentBeat += 0.25;
            }
        }, scheduleInterval);

        requestAnimationFrame(updateUI);
    }

    function scheduleTick(time, secondsPerBeat, staffs, maxDuration) {
        if (currentBeat >= maxDuration) return;
        staffs.forEach(function(notes, staffIdx) {
            let accumulated = 0;
            for (let i = 0; i < notes.length; i++) {
                const note = notes[i];
                if (Math.abs(accumulated - currentBeat) < 0.01) {
                    const url = note.type === 'note' ? audioMgr.getNoteFileName(note.toolId, note.pitchIndex) : audioMgr.getRestFileName(note.toolId);
                    audioMgr.scheduleBuffer(url, time);
                    scheduledEvents.push({ time: time, staffIdx: staffIdx, measureIdx: note.measureIdx, noteIdx: note.noteIdx });
                    
                    const endTime = time + (note.beat * secondsPerBeat);
                    if (endTime > playbackEndTime) playbackEndTime = endTime;
                    break;
                }
                accumulated += note.beat;
                if (accumulated > currentBeat) break;
            }
        });
    }

    function updateUI() {
        if (!isPlaying) return;
        const currentTime = audioMgr.ctx.currentTime;
        while (scheduledEvents.length > 0 && scheduledEvents[0].time <= currentTime) {
            const ev = scheduledEvents.shift();
            const $staff = $('.staff-wrapper').eq(ev.staffIdx);
            $staff.find('.placed-note').removeClass('playing-note');
            const $measure = $staff.find('.measure').eq(ev.measureIdx);
            $measure.find('.placed-note').eq(ev.noteIdx).addClass('playing-note');
        }
        
        if (schedulerTimer === null && scheduledEvents.length === 0 && currentTime >= playbackEndTime) {
            stopPlayback();
            return;
        }
        uiAnimationId = requestAnimationFrame(updateUI);
    }

    $('#play-btn').on('click', function() {
        if (isPlaying) stopPlayback();
        else startPlayback();
    });
    $('#stop-btn').on('click', stopPlayback);

    // --- 스케일링 로직 (1280x720 고정 비율) ---
    function updateScale() {
        const scaleX = window.innerWidth / 1280;
        const scaleY = window.innerHeight / 720;
        currentScale = Math.min(scaleX, scaleY);
        $appScaler.css('transform', 'scale(' + currentScale + ')');
    }
    $(window).on('resize', updateScale);
    updateScale();

    // --- 도구 및 데이터 상태 ---
    let currentTool = { type: 'note', id: '3', beat: 1 };
    let isDeleteMode = false;
    const pitchData = [
        { y: 7, isLine: false },    { y: 13, isLine: true },
        { y: 19, isLine: false },   { y: 25.7, isLine: true },
        { y: 31.9, isLine: false }, { y: 38.1, isLine: true },
        { y: 44.3, isLine: false }, { y: 50.55, isLine: true },
        { y: 56.8, isLine: false }, { y: 63, isLine: true },
        { y: 69.2, isLine: false }, { y: 75.4, isLine: true },
        { y: 81.6, isLine: false }, { y: 87.8, isLine: true },
        { y: 94, isLine: false }
    ];
    const pitchY = pitchData.map(p => p.y);

    function createStaff(id) {
        const $wrapper = $('<div>', { class: 'staff-wrapper', 'data-staff-id': id });
        const $content = $('<div>', { class: 'staff-content' });
        for (let i = 0; i < 4; i++) $content.append($('<div>', { class: 'measure' }));
        $wrapper.append($content);
        return $wrapper;
    }

    // --- 드래그 앤 드롭 로직 (기기별 이벤트 분리) ---
    let isDragging = false;
    let $dragPreview = null;
    let dragTool = null;
    let lastPitchIndex = -1;
    let lastPlayTime = 0;
    let $selectedNote = null;

    // 기기 환경 체크 (간단한 터치 지원 여부)
    const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

    // 공통 드래그 시작 로직
    function startDragging(tool, coords) {
        if ($dragPreview) $dragPreview.remove();

        dragTool = tool;
        isDragging = true;
        lastPitchIndex = -1;
        const imgSrc = 'images/' + dragTool.type + '_' + dragTool.id + '.svg';
        $dragPreview = $('<div>', { class: 'drag-preview' }).append($('<img>', { src: imgSrc })).appendTo('body');
        if (dragTool.type === 'rest') $dragPreview.addClass('rest-type');
        if (dragTool.id == 7) $dragPreview.addClass('whole-note');
        
        updateDragPreview(coords);
    }

    // --- 이벤트 바인딩 분리 ---
    if (isTouch) {
        // 모바일 터치 이벤트
        $('.tool-btn').on('touchstart', function(e) {
            const touch = e.originalEvent.touches[0];
            startDragging({ type: $(this).data('type'), id: $(this).data('id'), beat: $(this).data('beat') }, touch);
            e.preventDefault();
        });

        $scoreContainer.on('touchstart', '.placed-note', function(e) {
            e.stopPropagation();
            const $note = $(this);
            const touch = e.originalEvent.touches[0];
            handleItemSelection($note, touch);
            e.preventDefault();
        });

        $(document).on('touchmove', function(e) {
            if (!isDragging || !$dragPreview) return;
            handleDragging(e.originalEvent.touches[0]);
            e.preventDefault();
        });

        $(document).on('touchend', function(e) {
            if (!isDragging) return;
            handleDragEnd(e.originalEvent.changedTouches[0]);
        });
    } else {
        // PC 마우스 이벤트
        $('.tool-btn').on('mousedown', function(e) {
            if (e.button !== 0) return;
            startDragging({ type: $(this).data('type'), id: $(this).data('id'), beat: $(this).data('beat') }, e);
        });

        $scoreContainer.on('mousedown', '.placed-note', function(e) {
            if (e.button !== 0) return;
            e.stopPropagation();
            handleItemSelection($(this), e);
        });

        $(document).on('mousemove', function(e) {
            if (!isDragging || !$dragPreview) return;
            handleDragging(e);
        });

        $(document).on('mouseup', function(e) {
            if (!isDragging) return;
            handleDragEnd(e);
        });
    }

    // 공통 아이템 선택/삭제 처리
    function handleItemSelection($note, coords) {
        const $measure = $note.closest('.measure');
        let notes = $measure.data('notes') || [];
        const noteId = $note.data('id');
        const noteData = notes.find(n => n.id === noteId);

        if (!noteData) return;

        if (isDeleteMode) {
            notes = notes.filter(n => n.id !== noteId);
            $measure.data('notes', notes);
            renderMeasure($measure);
            $selectedNote = null;
            return;
        }

        $('.placed-note').removeClass('selected');
        $note.addClass('selected');
        $selectedNote = $note;

        // 드래그 전환을 위해 기존 데이터에서 제거 후 렌더링
        notes = notes.filter(n => n.id !== noteId);
        $measure.data('notes', notes);
        renderMeasure($measure);

        startDragging({ type: noteData.type, id: noteData.toolId, beat: noteData.beat }, coords);
    }

    // 공통 드래그 중 처리
    function handleDragging(coords) {
        $('.measure').removeClass('drag-over');
        $('.snap-guide').remove();
        $('.insertion-guide').remove();
        
        const elementUnderMouse = document.elementFromPoint(coords.clientX, coords.clientY);
        const $measure = $(elementUnderMouse).closest('.measure');
        
        let isFull = false;
        if ($measure.length > 0) {
            const notes = $measure.data('notes') || [];
            let total = 0;
            notes.forEach(n => total += n.beat);
            if (total + dragTool.beat > 4.001) isFull = true;
        }

        if (isFull) { $dragPreview.css('visibility', 'hidden'); return; }
        else { $dragPreview.css('visibility', 'visible'); }

        updateDragPreview(coords, elementUnderMouse);
        
        if ($measure.length > 0) {
            $measure.addClass('drag-over');
            const rect = $measure[0].getBoundingClientRect();
            const relX = (coords.clientX - rect.left) / currentScale;
            const relY = (coords.clientY - rect.top) / currentScale;
            
            let pitchIndex = 0;
            let minDist = Math.abs(relY - pitchData[0].y);
            pitchData.forEach((p, idx) => {
                const d = Math.abs(relY - p.y);
                if (d < minDist) { minDist = d; pitchIndex = idx; }
            });

            const measureWidth = $measure.width();
            const padding = 30;
            const activeWidth = measureWidth - (padding * 2);
            const measureNotes = $measure.data('notes') || [];
            let acc = 0;
            let snapX = padding;
            for (let i = 0; i < measureNotes.length; i++) {
                const pos = padding + (acc / 4) * activeWidth;
                if (relX < pos + 20) { snapX = pos; break; }
                acc += measureNotes[i].beat;
                snapX = padding + (acc / 4) * activeWidth;
            }

            const isSound = $('#toggle-drag-sound').is(':checked');
            const now = Date.now();
            if (isSound && (now - lastPlayTime > 50)) {
                if (dragTool.type === 'note' && pitchIndex !== lastPitchIndex) {
                    audioMgr.playImmediately(audioMgr.getNoteFileName(dragTool.id, pitchIndex));
                    lastPitchIndex = pitchIndex; lastPlayTime = now;
                } else if (dragTool.type === 'rest' && lastPitchIndex === -1) {
                    audioMgr.playImmediately(audioMgr.getRestFileName(dragTool.id));
                    lastPitchIndex = 7; lastPlayTime = now;
                }
            }

            $('<div class="snap-guide"></div>').css('top', pitchData[pitchIndex].y + 'px')
                .addClass(pitchData[pitchIndex].isLine ? 'is-line' : 'is-space').appendTo($measure);
            $('<div class="insertion-guide"></div>').css('left', snapX + 'px').appendTo($measure);
        } else { lastPitchIndex = -1; }
    }

    // 공통 드래그 종료 처리
    function handleDragEnd(coords) {
        const elementUnderMouse = document.elementFromPoint(coords.clientX, coords.clientY);
        const $measure = $(elementUnderMouse).closest('.measure');
        
        $('.snap-guide').remove();
        if ($measure.length > 0) {
            const rect = $measure[0].getBoundingClientRect();
            const relX = (coords.clientX - rect.left) / currentScale;
            const relY = (coords.clientY - rect.top) / currentScale;
            let pIdx = 0;
            let mD = Math.abs(relY - pitchY[0]);
            pitchY.forEach((y, i) => {
                const d = Math.abs(relY - y);
                if (d < mD) { mD = d; pIdx = i; }
            });
            placeNote($measure, relX, pitchY[pIdx], dragTool, pIdx);
        }
        stopDragging();
    }

    function updateDragPreview(coords, elementUnderMouse) {
        if (!$dragPreview) return;
        $dragPreview.css({ left: coords.clientX + 'px', top: coords.clientY + 'px', transform: 'translate(-50%, -50%) scale(' + currentScale + ')' });
        
        const element = elementUnderMouse || document.elementFromPoint(coords.clientX, coords.clientY);
        const $m = $(element).closest('.measure');
        if ($m.length > 0) {
            const rect = $m[0].getBoundingClientRect();
            const rY = (coords.clientY - rect.top) / currentScale;
            let pIdx = 0;
            let mD = Math.abs(rY - pitchY[0]);
            pitchY.forEach((y, i) => {
                const d = Math.abs(rY - y);
                if (d < mD) { mD = d; pIdx = i; }
            });
            if (dragTool.type === 'note') {
                $dragPreview.removeClass('whole-note reverse');
                if (dragTool.id == 7) $dragPreview.addClass('whole-note');
                else if (pIdx <= 6) $dragPreview.addClass('reverse');
            }
            const snappedY = rect.top + (pitchY[pIdx] * currentScale);
            $dragPreview.css({ 'top': snappedY + 'px' });
        }
    }

    function stopDragging() {
        isDragging = false;
        if ($dragPreview) { $dragPreview.remove(); $dragPreview = null; }
        $('.measure').removeClass('drag-over');
        dragTool = null;
    }

    function placeNote($measure, x, y, tool, pitchIndex) {
        const measureWidth = $measure.width();
        const padding = 30;
        const activeWidth = measureWidth - (padding * 2);
        let notes = $measure.data('notes') || [];
        let insIdx = notes.length;
        let acc = 0;
        for (let i = 0; i < notes.length; i++) {
            const pos = padding + (acc / 4) * activeWidth;
            if (x < pos + 20) { insIdx = i; break; }
            acc += notes[i].beat;
        }
        let total = 0;
        notes.forEach(n => total += n.beat);
        if (total + tool.beat > 4.001) return;
        const newNote = { id: Date.now() + Math.random(), type: tool.type, toolId: tool.id, beat: tool.beat, pitchIndex: pitchIndex };
        notes.splice(insIdx, 0, newNote);
        $measure.data('notes', notes);
        renderMeasure($measure);
    }

    function renderMeasure($measure) {
        $measure.find('.placed-note').remove();
        const notes = $measure.data('notes') || [];
        const measureWidth = $measure.width();
        const padding = 30;
        const activeWidth = measureWidth - (padding * 2);
        let acc = 0;
        notes.forEach(function(note) {
            const imgSrc = 'images/' + note.type + '_' + note.toolId + '.svg';
            const left = padding + (acc / 4) * activeWidth;
            let fY = pitchY[note.pitchIndex];
            if (note.type === 'rest') fY = pitchY[7];
            const $note = $('<div>', { class: 'placed-note', css: { left: left + 'px', top: fY + 'px' } })
                .data('id', note.id).append($('<img>', { src: imgSrc }));
            if (note.type === 'rest') $note.addClass('rest-type');
            else {
                if (note.toolId == 7) $note.addClass('whole-note');
                if (note.pitchIndex <= 6) $note.addClass('reverse');
            }
            $measure.append($note);
            acc += note.beat;
        });
    }

    // --- 편집 핸들러 ---
    $('#delete-selected').on('click', function() {
        isDeleteMode = !isDeleteMode;
        $(this).toggleClass('active', isDeleteMode);
        $scoreContainer.toggleClass('delete-cursor', isDeleteMode);
        
        if (isDeleteMode) {
            $('.placed-note').removeClass('selected');
            $selectedNote = null;
        }
    });

    $('#delete-all').on('click', function() {
        if (confirm('모든 악보 내용을 지우시겠습니까?')) {
            $('.measure').each(function() { $(this).data('notes', []); renderMeasure($(this)); });
            $selectedNote = null;
        }
    });

    $scoreContainer.on('click', '.measure', function(e) {
        if (isDeleteMode || isDragging) return;
        
        // 클릭한 위치가 이미 배치된 음표라면 무시 (mousedown에서 처리됨)
        if ($(e.target).closest('.placed-note').length > 0) return;

        const $measure = $(this);
        const offset = $measure.offset();
        // app-scaler의 현재 스케일 반영
        const scale = $appScaler[0].getBoundingClientRect().width / 1280;
        const relX = (e.pageX - offset.left) / scale;
        const relY = (e.pageY - offset.top) / scale;

        // 가장 가까운 음높이(pitch) 계산
        let pIdx = 0;
        let mD = Math.abs(relY - pitchY[0]);
        pitchY.forEach((y, i) => {
            const d = Math.abs(relY - y);
            if (d < mD) { mD = d; pIdx = i; }
        });

        // 음표 배치
        placeNote($measure, relX, pitchY[pIdx], currentTool, pIdx);
        
        // 배치 시 소리 피드백
        if (currentTool.type === 'note') {
            audioMgr.playImmediately(audioMgr.getNoteFileName(currentTool.id, pIdx));
        } else {
            audioMgr.playImmediately(audioMgr.getRestFileName(currentTool.id));
        }

        // 선택 상태 초기화
        $('.placed-note').removeClass('selected');
        $selectedNote = null;
    });

    $('#close-popup').on('click', () => $('#popup-overlay').addClass('popup-hidden'));
    $('#popup-overlay').on('click', function(e) { if (e.target === this) $(this).addClass('popup-hidden'); });

    $('.tool-btn').on('click', function() {
        $('.tool-btn').removeClass('active');
        $(this).addClass('active');
        currentTool = { type: $(this).data('type'), id: $(this).data('id'), beat: $(this).data('beat') };
    });

    $addStaffBtn.on('click', function() {
        staffCount++;
        const $newStaff = createStaff(staffCount);
        $scoreContainer.append($newStaff);
        $scoreContainer.animate({ scrollTop: $scoreContainer[0].scrollHeight }, 500);
    });

    $removeStaffBtn.on('click', function() {
        if (staffCount > 1) {
            $('.staff-wrapper').last().remove();
            staffCount--;
        }
        else alert('최소 한 줄은 유지해야 합니다.');
    });

    // --- 키보드 단축키 핸들러 ---
    $(document).on('keydown', function(e) {
        // 입력창(제목 등)에서 입력 중일 때는 단축키 무시
        if ($(e.target).is('input, textarea')) return;

        // Space: 재생/정지
        if (e.code === 'Space') {
            e.preventDefault();
            if (isPlaying) stopPlayback();
            else startPlayback();
        }
        // Delete or Backspace: 선택된 음표 삭제
        if ((e.code === 'Delete' || e.code === 'Backspace') && $selectedNote) {
            const $note = $selectedNote;
            const $measure = $note.closest('.measure');
            let notes = $measure.data('notes') || [];
            const noteId = $note.data('id');
            
            notes = notes.filter(n => n.id !== noteId);
            $measure.data('notes', notes);
            renderMeasure($measure);
            $selectedNote = null;
        }
    });

    // --- 이미지로 저장 (PNG) 로직 ---
    $('#save-png').on('click', function() {
        const $target = $('#score-container');
        const $btn = $(this);
        
        // UI 피드백 및 버튼 비활성화
        $btn.prop('disabled', true).css('opacity', '0.5');
        $('body').addClass('is-capturing');

        // 전체 높이 캡처를 위한 설정
        html2canvas($target[0], {
            backgroundColor: '#ecf0f1',
            scale: 2, // 고해상도 저장
            useCORS: true,
            logging: false,
            // 캡처를 위한 복제본 가공
            onclone: function(clonedDoc) {
                const $clonedApp = $(clonedDoc).find('#app-scaler');
                const $clonedTarget = $(clonedDoc).find('#score-container');
                
                // 복제본에서 스케일링 강제 초기화 (1:1 해상도)
                $clonedApp.css({
                    'transform': 'none',
                    'width': '1280px',
                    'height': 'auto',
                    'position': 'relative',
                    'overflow': 'visible',
                    'display': 'block'
                });

                $clonedTarget.css({
                    'overflow': 'visible',
                    'height': 'auto',
                    'width': '1254px',
                    'padding': '40px 20px',
                    'margin': '0 auto'
                });

                // 불필요한 요소 제거 및 하이라이트 초기화
                $clonedTarget.find('.playing-note').removeClass('playing-note');
                $clonedTarget.find('.selected').removeClass('selected');
                $clonedTarget.find('.snap-guide, .insertion-guide').remove();
            }
        }).then(function(canvas) {
            const link = document.createElement('a');
            const title = $('#score-title').val() || '나만의 악보';
            const timestamp = new Date().getTime();
            link.download = title + '_' + timestamp + '.png';
            link.href = canvas.toDataURL('image/png');
            link.click();
        }).catch(function(err) {
            console.error('PNG 저장 실패:', err);
            alert('이미지 저장에 실패했습니다.');
        }).finally(function() {
            // 상태 복구
            $btn.prop('disabled', false).css('opacity', '1');
            $('body').removeClass('is-capturing');
        });
    });

    console.log('UI 복구 및 정밀 스케줄러 연동 완료');
});