/**
 * Constructor for an analogue of the TimeRanges class
 * returned by various HTMLMediaElement properties
 *
 * Pass an array of two-element arrays, each containing a start and end time.
 */
OGVTimeRanges = window.OGVTimeRanges = function(ranges) {
	Object.defineProperty(this, 'length', {
		get: function getLength() {
			return ranges.length;
		}
	});
	this.start = function(i) {
		return ranges[i][0];
	};
	this.end = function(i) {
		return ranges[i][1];
	};
	return this;
};

/**
 * Player class -- instantiate one of these to get an 'ogvjs' HTML element
 * which has a similar interface to the HTML audio/video elements.
 *
 * @param options: optional dictionary of options:
 *                 'base': string; base URL for additional resources, such as Flash audio shim
 *                 'webGL': bool; pass true to use WebGL acceleration if available
 *                 'forceWebGL': bool; pass true to require WebGL even if not detected
 */
OGVPlayer = window.OGVPlayer = function(options) {
	options = options || {};

	var instanceId = 'ogvjs' + (++OGVPlayer.instanceCount);

	var codecClassName = null,
		codecClassFile = null,
		codecClass = null;

	var webGLdetected = WebGLFrameSink.isAvailable();
	var useWebGL = (options.webGL !== false) && webGLdetected;
	if(!!options.forceWebGL) {
		useWebGL = true;
		if(!webGLdetected) {
			console.log("No support for WebGL detected, but WebGL forced on!");
		}
	}

	// Experimental option
	var enableWebM = !!options.enableWebM;
	
	var State = {
		INITIAL: 'INITIAL',
		SEEKING_END: 'SEEKING_END',
		LOADED: 'LOADED',
		READY: 'READY',
		PLAYING: 'PLAYING',
		PAUSED: 'PAUSED',
		SEEKING: 'SEEKING',
		ENDED: 'ENDED'
	}, state = State.INITIAL;
	
	var SeekState = {
		NOT_SEEKING: 'NOT_SEEKING',
		BISECT_TO_TARGET: 'BISECT_TO_TARGET',
		BISECT_TO_KEYPOINT: 'BISECT_TO_KEYPOINT',
		LINEAR_TO_TARGET: 'LINEAR_TO_TARGET'
	}, seekState = SeekState.NOT_SEEKING;
	
	var audioOptions = {};
	if (typeof options.base === 'string') {
		// Pass the resource dir down to AudioFeeder,
		// so it can load the dynamicaudio.swf
		audioOptions.base = options.base;
	}
	if (typeof options.audioContext !== 'undefined') {
		// Try passing a pre-created audioContext in?
		audioOptions.audioContext = options.audioContext;
	}
	
	var canvas = document.createElement('canvas');
	var frameSink;
	
	// Return a magical custom element!
	var self = document.createElement('ogvjs');
	self.className = instanceId;

	canvas.style.position = 'absolute';
	canvas.style.top = '0';
	canvas.style.left = '0';
	canvas.style.width = '100%';
	canvas.style.height = '100%';
	canvas.style.objectFit = 'contain';
	self.appendChild(canvas);

	var getTimestamp;
	if (window.performance === undefined || window.performance.now === undefined) {
		getTimestamp = Date.now;
	} else {
		getTimestamp = window.performance.now.bind(window.performance);
	}
	function time(cb) {
		var start = getTimestamp();
		cb();
		var delta = getTimestamp() - start;
		lastFrameDecodeTime += delta;
		return delta;
	}

	function fireEvent(eventName, props) {
		var event;
		props = props || {};

		if (typeof window.Event == 'function') {
			// standard event creation
			event = new CustomEvent(eventName);
		} else {
			// IE back-compat mode
			// https://msdn.microsoft.com/en-us/library/dn905219%28v=vs.85%29.aspx
			event = document.createEvent('Event');
			event.initEvent(eventName, false, false);
		}

		for (var prop in props) {
			if (props.hasOwnProperty(prop)) {
				event[prop] = props[prop];
			}
		}

		self.dispatchEvent(event);
	}

	var codec, audioFeeder;
	var muted = false,
		initialAudioPosition = 0.0,
		initialAudioOffset = 0.0;
	function initAudioFeeder() {
		audioFeeder = new AudioFeeder( audioOptions );
		if (muted) {
			audioFeeder.mute();
		}
		audioFeeder.onstarved = function() {
			// If we're in a background tab, timers may be throttled.
			// When audio buffers run out, go decode some more stuff.
			pingProcessing();
		};
		audioFeeder.init(audioInfo.channels, audioInfo.rate);
	}
	
	function startAudio(offset) {
		audioFeeder.start();
		var state = audioFeeder.getPlaybackState();
		initialAudioPosition = state.playbackPosition;
		if (offset !== undefined) {
			initialAudioOffset = offset;
		}
	}
	
	function stopAudio() {
		initialAudioOffset = getAudioTime();
		audioFeeder.stop();
	}
	
	/**
	 * Get audio playback time position in file's units
	 *
	 * @return {number} seconds since file start
	 */
	function getAudioTime(state) {
		state = state || audioFeeder.getPlaybackState();
		return (state.playbackPosition - initialAudioPosition) + initialAudioOffset;
	}

	var stream,
		byteLength = 0,
		duration = null,
		lastSeenTimestamp = null,
		nextProcessingTimer,
		started = false,
		paused = true,
		ended = false,
		loadedMetadata = false,
		startedPlaybackInDocument = false;
	
	var framesPlayed = 0;
	// Benchmark data, exposed via getPlaybackStats()
	var framesProcessed = 0, // frames
		targetPerFrameTime = 1000 / 60, // ms
		demuxingTime = 0, // ms
		videoDecodingTime = 0, // ms
		audioDecodingTime = 0, // ms
		bufferTime = 0, // ms
		drawingTime = 0, // ms
		totalJitter = 0; // sum of ms we're off from expected frame delivery time
	// Benchmark data that doesn't clear
	var droppedAudio = 0, // number of times we were starved for audio
		delayedAudio = 0; // seconds audio processing was delayed by blocked CPU

	function stopVideo() {
		// kill the previous video if any
		state = State.INITIAL;
		started = false;
		paused = true;
		ended = true;
		loadedMetadata = false;
		continueVideo = null;
		frameEndTimestamp = 0.0;
		lastFrameDecodeTime = 0.0;
		
		if (stream) {
			stream.abort();
			stream = null;
		}
		if (codec) {
			codec.destroy();
			codec = null;
		}
		if (audioFeeder) {
			audioFeeder.close();
			audioFeeder = undefined;
		}
		if (nextProcessingTimer) {
			clearTimeout(nextProcessingTimer);
			nextProcessingTimer = null;
		}
	}
	
	function togglePauseVideo() {
		if (self.paused) {
			self.play();
		} else {
			self.pause();
		}
	}
	
	var continueVideo = null;
	
	var lastFrameTime = getTimestamp(),
		frameEndTimestamp = 0.0,
		yCbCrBuffer = null;
	var lastFrameDecodeTime = 0.0;		
	var targetFrameTime;
	var lastFrameTimestamp = 0.0;

	function processFrame() {
		yCbCrBuffer = codec.dequeueFrame();
		frameEndTimestamp = yCbCrBuffer.timestamp;
	}

	function drawFrame() {
		if (thumbnail) {
			self.removeChild(thumbnail);
			thumbnail = null;
		}

		drawingTime += time(function() {
			frameSink.drawFrame(yCbCrBuffer);
		});

		framesProcessed++;
		framesPlayed++;

		doFrameComplete();
	}

	function doFrameComplete() {
		if (startedPlaybackInDocument && !document.body.contains(self)) {
			// We've been de-parented since we last ran
			// Stop playback at next opportunity!
			setTimeout(function() {
				self.stop();
			}, 0);
		}

		var newFrameTimestamp = getTimestamp(),
			wallClockTime = newFrameTimestamp - lastFrameTimestamp,
			jitter = Math.abs(wallClockTime - 1000 / fps);
		totalJitter += jitter;

		fireEvent('framecallback', {
			cpuTime: lastFrameDecodeTime,
			clockTime: wallClockTime
		});
		lastFrameDecodeTime = 0;
		lastFrameTimestamp = newFrameTimestamp;
	}


	// -- seek functions
	var seekTargetTime = 0.0,
		seekTargetKeypoint = 0.0,
		bisectTargetTime = 0.0,
		lastSeekPosition,
		lastFrameSkipped,
		seekBisector;

	function startBisection(targetTime) {
		bisectTargetTime = targetTime;
		seekBisector = new Bisector({
			start: 0,
			end: stream.bytesTotal - 1,
			process: function(start, end, position) {
				if (position == lastSeekPosition) {
					return false;
				} else {
					lastSeekPosition = position;
					lastFrameSkipped = false;
					codec.flush();
					stream.seek(position);
					stream.readBytes();
					return true;
				}
			}
		});
		seekBisector.start();
	}

	function seek(toTime) {
		if (stream.bytesTotal === 0) {
			throw new Error('Cannot bisect a non-seekable stream');
		}
		state = State.SEEKING;
		seekTargetTime = toTime;
		seekTargetKeypoint = -1;
		lastFrameSkipped = false;
		lastSeekPosition = -1;
		codec.flush();
		
		if (codec.hasAudio && audioFeeder) {
			stopAudio();
		}
		
		var offset = codec.getKeypointOffset(toTime);
		if (offset > 0) {
			// This file has an index!
			//
			// Start at the keypoint, then decode forward to the desired time.
			//
			seekState = SeekState.LINEAR_TO_TARGET;
			stream.seek(offset);
			stream.readBytes();
		} else {
			// No index.
			//
			// Bisect through the file finding our target time, then we'll
			// have to do it again to reach the keypoint, and *then* we'll
			// have to decode forward back to the desired time.
			//
			seekState = SeekState.BISECT_TO_TARGET;
			startBisection(seekTargetTime);
		}
	}
	
	function continueSeekedPlayback() {
		seekState = SeekState.NOT_SEEKING;
		state = State.PLAYING;
		frameEndTimestamp = codec.frameTimestamp;
		if (codec.hasAudio) {
			seekTargetTime = codec.audioTimestamp;
			startAudio(seekTargetTime);
		} else {
			seekTargetTime = codec.frameTimestamp;
		}
	}
	
	/**
	 * @return {boolean} true to continue processing, false to wait for input data
	 */
	function doProcessLinearSeeking() {
		var frameDuration;
		if (codec.hasVideo) {
			frameDuration = 1 / videoInfo.fps;
		} else {
			frameDuration = 1 / 256; // approximate packet audio size, fake!
		}
		
		if (codec.hasVideo) {
			if (!codec.frameReady) {
				// Haven't found a frame yet, process more data
				return true;
			} else if (codec.frameTimestamp < 0 || codec.frameTimestamp + frameDuration < seekTargetTime) {
				// Haven't found a time yet, or haven't reached the target time.
				// Decode it in case we're at our keyframe or a following intraframe...
				if (codec.decodeFrame()) {
					codec.dequeueFrame();
				}
				return true;
			} else {
				// Reached or surpassed the target time. 
				if (codec.hasAudio) {
					// Keep processing the audio track
				} else {
					continueSeekedPlayback();
					return false;
				}
			}
		}
		if (codec.hasAudio) {
			if (!codec.audioReady) {
				// Haven't found an audio packet yet, process more data
				return true;
			}
			if (codec.audioTimestamp < 0 || codec.audioTimestamp + frameDuration < seekTargetTime) {
				// Haven't found a time yet, or haven't reached the target time.
				// Decode it so when we reach the target we've got consistent data.
				if (codec.decodeAudio()) {
					codec.dequeueAudio();
				}
				return true;
			} else {
				continueSeekedPlayback();
				return false;
			}
		}
		return true;
	}
	
	function doProcessBisectionSeek() {
		var frameDuration,
			timestamp;
		if (codec.hasVideo) {
			if (!codec.frameReady) {
				// Haven't found a frame yet, process more data
				return true;
			}
			timestamp = codec.frameTimestamp;
			frameDuration = 1 / videoInfo.fps;
		} else if (codec.hasAudio) {
			if (!codec.audioReady) {
				// Haven't found an audio packet yet, process more data
				return true;
			}
			timestamp = codec.audioTimestamp;
			frameDuration = 1 / 256; // approximate packet audio size, fake!
		} else {
			throw new Error('Invalid seek state; no audio or video track available');
		}

		if (timestamp < 0) {
			// Haven't found a time yet.
			// Decode in case we're at our keyframe or a following intraframe...
			if (codec.frameReady) {
				if (codec.decodeFrame()) {
					codec.dequeueFrame();
				}
			}
			if (codec.audioReady) {
				if (codec.decodeAudio()) {
					codec.dequeueAudio();
				}
			}
			return true;
		} else if (timestamp - frameDuration > bisectTargetTime) {
			if (seekBisector.left()) {
				// wait for new data to come in
			} else {
				seekTargetTime = codec.frameTimestamp;
				continueSeekedPlayback();
			}
			return false;
		} else if (timestamp + frameDuration < bisectTargetTime) {
			if (seekBisector.right()) {
				// wait for new data to come in
			} else {
				seekTargetTime = codec.frameTimestamp;
				continueSeekedPlayback();
			}
			return false;
		} else {
			// Reached the bisection target!
			if (seekState == SeekState.BISECT_TO_TARGET && (codec.hasVideo && codec.keyframeTimestamp < codec.frameTimestamp)) {
				// We have to go back and find a keyframe. Sigh.
				seekState = SeekState.BISECT_TO_KEYPOINT;
				startBisection(codec.keyframeTimestamp);
				return false;
			} else {
				// Switch to linear mode to find the final target.
				seekState = SeekState.LINEAR_TO_TARGET;
				return true;
			}
		}
		return true;
	}
	

	function doProcessing() {
		nextProcessingTimer = null;
		
		var audioBufferedDuration = 0,
			audioState = null,
			audioPlaybackPosition = 0;

		var n = 0;
		while (true) {
			n++;
			if (n > 100) {
				//throw new Error("Got stuck in the loop!");
				console.log("Got stuck in the loop!");
				pingProcessing(10);
				return;
			}

			if (state == State.INITIAL) {
				var more = codec.process();

				if (loadedMetadata) {
					// we just fell over from headers into content; call onloadedmetadata etc
					if (!codec.hasVideo && !codec.hasAudio) {
						throw new Error('No audio or video found, something is wrong');
					}
					if (duration === null) {
						if (stream.seekable) {
							state = State.SEEKING_END;
							lastSeenTimestamp = -1;
							codec.flush();
							stream.seek(Math.max(0, stream.bytesTotal - 65536 * 2));
							stream.readBytes();
							return;
						} else {
							// Stream not seekable and no x-content-duration; assuming infinite stream.
							state = State.LOADED;
							continue;
						}
					} else {
						// We already know the duration.
						state = State.LOADED;
						continue;
					}
				}

				if (!more) {
					// Read more data!
					stream.readBytes();
					return;
				} else {
					// Keep processing headers
					continue;
				}
			}
			
			if (state == State.SEEKING_END) {
				// Look for the last item.
				var more = codec.process();
				
				if (codec.hasVideo && codec.frameReady) {
					lastSeenTimestamp = Math.max(lastSeenTimestamp, codec.frameTimestamp);
					codec.discardFrame();
				}
				if (codec.hasAudio && codec.audioReady) {
					lastSeenTimestamp = Math.max(lastSeenTimestamp, codec.audioTimestamp);
					if (codec.decodeAudio()) {
						codec.dequeueAudio();
					}
				}
				
				if (!more) {
					// Read more data!
					if (stream.bytesRead < stream.bytesTotal) {
						stream.readBytes();
						return;
					} else {
						// We are at the end!
						if (lastSeenTimestamp > 0) {
							duration = lastSeenTimestamp;
						}
						
						// Ok, seek back to the beginning and resync the streams.
						state = State.LOADED;
						codec.flush();
						stream.seek(0);
						stream.readBytes();
						return;
					}
				} else {
					// Keep processing headers
					continue;
				}
			}
			
			if (state == State.LOADED) {
				state = State.READY;
				fireEvent('loadedmetadata');
				if (paused) {
					// Paused? stop here.
					return;
				} else {
					// Not paused? Continue on to play processing.
					continue;
				}
			}
			
			if (state == State.READY) {
				state = State.PLAYING;
				lastFrameTimestamp = getTimestamp();
				targetFrameTime = lastFrameTimestamp + 1000.0 / fps;
				if (codec.hasAudio) {
					initAudioFeeder();
					audioFeeder.waitUntilReady(function() {
						startAudio(0.0);
						pingProcessing(0);
					});
				} else {
					pingProcessing(0);
				}

				// Fall over to play processing
				return;
			}
			
			if (state == State.SEEKING) {
				if (!codec.process()) {
					stream.readBytes();
					return;
				}
				if (seekState == SeekState.NOT_SEEKING) {
					throw new Error('seeking in invalid state (not seeking?)');
				} else if (seekState == SeekState.BISECT_TO_TARGET) {
					doProcessBisectionSeek();
				} else if (seekState == SeekState.BISECT_TO_KEYPOINT) {
					doProcessBisectionSeek();
				} else if (seekState == SeekState.LINEAR_TO_TARGET) {
					doProcessLinearSeeking();
				}
				
				// Back to the loop to process more data
				continue;
			}
			
			// Process until we run out of data or
			// completely decode a video frame...
			var currentTime = getTimestamp();
			var more;
			demuxingTime += time(function() {
				more = codec.process();
			});

			if (!more) {
				if (stream) {
					// Ran out of buffered input
					stream.readBytes();
				} else {
					// Ran out of stream!
					var finalDelay = 0;
					if (codec.hasAudio) {
						// This doesn't seem to be enough with Flash audio shim.
						// Not quite sure why.
						finalDelay = audioBufferedDuration;
					}
					setTimeout(function() {
						stopVideo();
						ended = true;
						fireEvent('ended');
					}, finalDelay);
				}
				return;
			}
			
			if ((codec.hasAudio || codec.hasVideo) && !(codec.audioReady || codec.frameReady)) {
				// Have to process some more pages to find data. Continue the loop.
				continue;
			}

			if (codec.hasAudio && audioFeeder) {
				if (!audioState) {
					audioState = audioFeeder.getPlaybackState();
					audioPlaybackPosition = getAudioTime(audioState);
					audioBufferedDuration = (audioState.samplesQueued / audioFeeder.targetRate) * 1000;
					droppedAudio = audioState.dropped;
					delayedAudio = audioState.delayed;
				}

				// Drive on the audio clock!
				var fudgeDelta = 0.1,
					readyForAudio = audioState.samplesQueued <= (audioFeeder.bufferSize * 2),
					frameDelay = (frameEndTimestamp - audioPlaybackPosition) * 1000,
					readyForFrame = (frameDelay <= fudgeDelta);

				var startTimeSpent = getTimestamp();
				if (codec.audioReady && readyForAudio) {
					var ok;
					audioDecodingTime += time(function() {
						ok = codec.decodeAudio();
					});

					if (ok) {
						var buffer = codec.dequeueAudio();
						if (buffer) {
							// Keep track of how much time we spend queueing audio as well
							// This is slow when using the Flash shim on IE 10/11
							bufferTime += time(function() {
								audioFeeder.bufferData(buffer);
							});
							audioBufferedDuration += (buffer[0].length / audioInfo.rate) * 1000;
						}
					}
				}
				if (codec.frameReady && readyForFrame) {
					var ok;
					videoDecodingTime += time(function() {
						ok = codec.decodeFrame();
					});
					if (ok) {
						processFrame();
						drawFrame();
					} else {
						// Bad packet or something.
						console.log('Bad video packet or something');
					}
					targetFrameTime = currentTime + 1000.0 / fps;
				}
			
				// Check in when all audio runs out
				var bufferDuration = (audioFeeder.bufferSize / audioFeeder.targetRate) * 1000;
				var nextDelays = [];
				if (audioBufferedDuration <= bufferDuration * 2) {
					// NEED MOAR BUFFERS
				} else {
					// Check in when the audio buffer runs low again...
					nextDelays.push(bufferDuration / 2);
					
					if (codec.hasVideo) {
						// Check in when the next frame is due
						// Subtract time we already spent decoding
						var deltaTimeSpent = getTimestamp() - startTimeSpent;
						nextDelays.push(frameDelay - deltaTimeSpent);
					}
				}
				
				var nextDelay = Math.min.apply(Math, nextDelays);
				if (nextDelays.length > 0) {
					if (!codec.hasVideo) {
						framesProcessed++; // pretend!
						doFrameComplete();
					}
					pingProcessing(Math.max(0, nextDelay));
					return;
				}
			} else if (codec.hasVideo) {
				// Video-only: drive on the video clock
				if (codec.frameReady && getTimestamp() >= targetFrameTime) {
					// it's time to draw
					var ok;
					videoDecodingTime += time(function() {
						ok = codec.decodeFrame();
					});
					if (ok) {
						processFrame();
						drawFrame();
						targetFrameTime += 1000.0 / fps;
						pingProcessing(0);
					} else {
						console.log('Bad video packet or something');
						pingProcessing(Math.max(0, targetFrameTime - getTimestamp()));
					}
				} else {
					// check in again soon!
					pingProcessing(Math.max(0, targetFrameTime - getTimestamp()));
				}
				return;
			} else {
				// Ok we're just waiting for more input.
			}
		}
	}

	function pingProcessing(delay) {
		if (delay === undefined) {
			delay = -1;
		}
		if (delay >= 0) {
			if (nextProcessingTimer) {
				// already scheduled
				return;
			}
			nextProcessingTimer = setTimeout(doProcessing, delay);
		} else {
			if (nextProcessingTimer) {
				clearTimeout(nextProcessingTimer);
			}
			doProcessing(); // warning: tail recursion is possible
		}
	}

	var fps = 60;

	var videoInfo,
		audioInfo;

	function startProcessingVideo() {
		if (started || codec) {
			return;
		}
		var options = {};
		
		// Mozilla/5.0 (Macintosh; Intel Mac OS X 10_8_5) AppleWebKit/536.30.1 (KHTML, like Gecko) Version/6.0.5 Safari/536.30.1
		if (navigator.userAgent.match(/Version\/6\.0\.[0-9a-z.]+ Safari/)) {
			// Something may be wrong with the JIT compiler in Safari 6.0;
			// when we decode Vorbis with the debug console closed it falls
			// into 100% CPU loop and never exits.
			//
			// Blacklist audio decoding for this browser.
			//
			// Known working in Safari 6.1 and 7.
			options.audio = false;
			console.log('Audio disabled due to bug on Safari 6.0');
		}
		
		framesProcessed = 0;
		demuxingTime = 0;
		videoDecodingTime = 0;
		audioDecodingTime = 0;
		bufferTime = 0;
		drawingTime = 0;
		started = true;
		ended = false;

		codec = new codecClass(options);
		codec.oninitvideo = function(info) {
			videoInfo = info;
			fps = info.fps;
			targetPerFrameTime = 1000 / fps;

			canvas.width = info.displayWidth;
			canvas.height = info.displayHeight;
			OGVPlayer.styleManager.appendRule('.' + instanceId, {
				width: info.displayWidth + 'px',
				height: info.displayHeight + 'px'
			});
			OGVPlayer.updatePositionOnResize();

			if (useWebGL) {
				frameSink = new WebGLFrameSink(canvas, videoInfo);
			} else {
				frameSink = new FrameSink(canvas, videoInfo);
			}
		};
		codec.oninitaudio = function(info) {
			audioInfo = info;
		};
		codec.onloadedmetadata = function() {
			loadedMetadata = true;
			if (!isNaN(codec.duration)) {
				// Use duration from ogg skeleton index
				duration = codec.duration;
			}
		};

		stream.readBytes();
	}
	
	function loadCodec(callback) {
		// @todo fix this proper
		if (enableWebM && self.src.match(/\.webm$/i)) {
			codecClassName = 'OGVWebMDecoder';
			codecClassFile = 'webm-codec.js';
		} else {
			codecClassName = 'OGVOggDecoder';
			codecClassFile = 'ogv-codec.js';
		}
		codecClass = window[codecClassName];
		if (typeof codecClass === 'function') {
			if (callback) {
				callback();
			}
		} else if (OGVPlayer.loadingNode !== null) {
			if (callback) {
				OGVPlayer.loadingCallbacks.push(callback);
			}
		} else {
			if (callback) {
				OGVPlayer.loadingCallbacks.push(callback);
			}
			OGVPlayer.loadingNode = document.createElement('script');
			document.querySelector('head').appendChild(OGVPlayer.loadingNode);

			var url = codecClassFile;
			if (options.base) {
				url = options.base + '/' + url;
			}
			if (typeof window.OGVVersion === 'string') {
				url = url + '?version=' + encodeURIComponent(window.OGVVersion);
			}
			
			OGVPlayer.loadingNode.addEventListener('load', function() {
				codecClass = window[codecClassName];
				if (typeof codecClass === 'function') {
					OGVPlayer.loadingCallbacks.forEach(function(cb) {
						cb();
					});
					OGVPlayer.loadingNode.onload = null;
					OGVPlayer.loadingCallbacks.splice(0, OGVPlayer.loadingCallbacks.length);
					OGVPlayer.loadingNode.parentNode.removeChild(OGVPlayer.loadingNode);
					OGVPlayer.loadingNode = null;
				} else {
					throw new Error('Could not load ' + codecClassFile);
				}
			});
			OGVPlayer.loadingNode.src = url;
		}
	}
	
	/**
	 * HTMLMediaElement load method
	 */
	self.load = function() {
		if (stream) {
			// already loaded.
			return;
		}
	
		loadCodec();

		started = false;
		stream = new StreamFile({
			url: self.src,
			bufferSize: 65536 * 4,
			onstart: function() {
				// Fire off the read/decode/draw loop...
				byteLength = stream.bytesTotal;
			
				// If we get X-Content-Duration, that's as good as an explicit hint
				var durationHeader = stream.getResponseHeader('X-Content-Duration');
				if (typeof durationHeader === 'string') {
					duration = parseFloat(durationHeader);
				}
				loadCodec(startProcessingVideo);
			},
			onread: function(data) {
				// Pass chunk into the codec's buffer
				codec.receiveInput(data);

				// Continue the read/decode/draw loop...
				pingProcessing();
			},
			ondone: function() {
				if (state == State.SEEKING) {
					pingProcessing();
				} else if (state == State.SEEKING_END) {
					pingProcessing();
				} else {
					stream = null;
			
					// Let the read/decode/draw loop know we're out!
					pingProcessing();
				}
			},
			onerror: function(err) {
				console.log("reading error: " + err);
			}
		});
	};
	
	/**
	 * HTMLMediaElement canPlayType method
	 */
	self.canPlayType = function(contentType) {
		var type = new OGVMediaType(contentType);
		if (type.minor === 'ogg' &&
			(type.major === 'audio' || type.major === 'video' || type.major === 'application')) {
			if (type.codecs) {
				var supported = ['vorbis', 'opus', 'theora'],
					knownCodecs = 0,
					unknownCodecs = 0;
				type.codecs.forEach(function(codec) {
					if (supported.indexOf(codec) >= 0) {
						knownCodecs++;
					} else {
						unknownCodecs++;
					}
				});
				if (knownCodecs == 0) {
					return '';
				} else if (unknownCodecs > 0) {
					return '';
				}
				// All listed codecs are ones we know. Neat!
				return 'probably';
			} else {
				return 'maybe';
			}
		} else {
			// @todo when webm support is more complete, handle it
			return '';
		}
	};
	
	/**
	 * HTMLMediaElement play method
	 */
	self.play = function() {
		if (!audioOptions.audioContext) {
			OGVPlayer.initSharedAudioContext();
		}
		
		if (!stream) {
			self.load();
		}
		
		if (paused) {
			startedPlaybackInDocument = document.body.contains(self);
			paused = false;
			if (continueVideo) {
				continueVideo();
			} else {
				continueVideo = function() {
					if (audioFeeder) {
						startAudio();
					}
					pingProcessing(0);
				};
				if (!started) {
					loadCodec(startProcessingVideo);
				} else {
					continueVideo();
				}
			}
			fireEvent('play');
		}
	};
	
	/**
	 * custom getPlaybackStats method
	 */
	self.getPlaybackStats = function() {
		return {
			targetPerFrameTime: targetPerFrameTime,
			framesProcessed: framesProcessed,
			demuxingTime: demuxingTime,
			videoDecodingTime: videoDecodingTime,
			audioDecodingTime: audioDecodingTime,
			bufferTime: bufferTime,
			drawingTime: drawingTime,
			droppedAudio: droppedAudio,
			delayedAudio: delayedAudio,
			jitter: totalJitter / framesProcessed
		};
	};
	self.resetPlaybackStats = function() {
		framesProcessed = 0;
		demuxingTime = 0;
		videoDecodingTime = 0;
		audioDecodingTime = 0;
		bufferTime = 0;
		drawingTime = 0;
		totalJitter = 0;
	};
	
	/**
	 * HTMLMediaElement pause method
	 */
	self.pause = function() {
		if (!stream) {
			paused = true;
			self.load();
		} else if (!paused) {
			clearTimeout(nextProcessingTimer);
			nextProcessingTimer = null;
			if (audioFeeder) {
				stopAudio();
			}
			paused = true;
			fireEvent('pause');
		}
	};
	
	/**
	 * custom 'stop' method
	 */
	self.stop = function() {
		stopVideo();
	};

	/**
	 * HTMLMediaElement src property
	 */
	self.src = "";
	
	/**
	 * HTMLMediaElement buffered property
	 */
	Object.defineProperty(self, "buffered", {
		get: function getBuffered() {
			var estimatedBufferTime;
			if (stream && byteLength && duration) {
				estimatedBufferTime = (stream.bytesBuffered / byteLength) * duration;
			} else {
				estimatedBufferTime = 0;
			}
			return new OGVTimeRanges([[0, estimatedBufferTime]]);
		}
	});
	
	/**
	 * HTMLMediaElement seekable property
	 */
	Object.defineProperty(self, "seekable", {
		get: function getSeekable() {
			if (duration === null) {
				return new OGVTimeRanges([]);
			} else {
				return new OGVTimeRanges([[0, duration]]);
			}
		}
	});
	
	/**
	 * HTMLMediaElement currentTime property
	 */
	Object.defineProperty(self, "currentTime", {
		get: function getCurrentTime() {
			if (state == State.SEEKING) {
				return seekTargetTime;
			} else {
				if (codec && codec.hasAudio && audioFeeder) {
					if (paused) {
						return initialAudioOffset;
					} else {
						return getAudioTime();
					}
				} else if (codec && codec.hasVideo) {
					return frameEndTimestamp;
				} else {
					return 0;
				}
			}
		},
		set: function setCurrentTime(val) {
			if (stream && byteLength && duration) {
				seek(val);
			}
		}
	});
	
	/**
	 * HTMLMediaElement duration property
	 */
	Object.defineProperty(self, "duration", {
		get: function getDuration() {
			if (codec && loadedMetadata) {
				if (duration !== null) {
					return duration;
				} else {
					return Infinity;
				}
			} else {
				return NaN;
			}
		}
	});
	
	/**
	 * HTMLMediaElement paused property
	 */
	Object.defineProperty(self, "paused", {
		get: function getPaused() {
			return paused;
		}
	});
	
	/**
	 * HTMLMediaElement ended property
	 */
	Object.defineProperty(self, "ended", {
		get: function getEnded() {
			return ended;
		}
	});
	
	/**
	 * HTMLMediaElement ended property
	 */
	Object.defineProperty(self, "seeking", {
		get: function getEnded() {
			return (state == State.SEEKING);
		}
	});
	
	/**
	 * HTMLMediaElement muted property
	 */
	Object.defineProperty(self, "muted", {
		get: function getMuted() {
			return muted;
		},
		set: function setMuted(val) {
			muted = val;
			if (audioFeeder) {
				if (muted) {
					audioFeeder.mute();
				} else {
					audioFeeder.unmute();
				}
			}
		}
	});
	
	var poster = '', thumbnail;
	Object.defineProperty(self, "poster", {
		get: function getPoster() {
			return poster;
		},
		set: function setPoster(val) {
			poster = val;
			if (!started) {
				if (thumbnail) {
					self.removeChild(thumbnail);
				}
				thumbnail = new Image();
				thumbnail.src = poster;
				thumbnail.className = 'ogvjs-poster';
				thumbnail.style.position = 'absolute';
				thumbnail.style.top = '0';
				thumbnail.style.left = '0';
				thumbnail.style.width = '100%';
				thumbnail.style.height = '100%';
				thumbnail.style.objectFit = 'contain';
				thumbnail.addEventListener('load', function() {
					OGVPlayer.styleManager.appendRule('.' + instanceId, {
						width: thumbnail.naturalWidth + 'px',
						height: thumbnail.naturalHeight + 'px'
					});
					OGVPlayer.updatePositionOnResize();
				});
				self.appendChild(thumbnail);
			}
		}
	});
	
	// Video metadata properties...
	Object.defineProperty(self, "videoWidth", {
		get: function getVideoWidth() {
			if (videoInfo) {
				return videoInfo.picWidth;
			} else {
				return 0;
			}
		}
	});
	Object.defineProperty(self, "videoHeight", {
		get: function getVideoHeight() {
			if (videoInfo) {
				return videoInfo.picHeight;
			} else {
				return 0;
			}
		}
	});
	Object.defineProperty(self, "ogvjsVideoFrameRate", {
		get: function getOgvJsVideoFrameRate() {
			if (videoInfo) {
				return videoInfo.fps;
			} else {
				return 0;
			}
		}
	});
	
	// Audio metadata properties...
	Object.defineProperty(self, "ogvjsAudioChannels", {
		get: function getOgvJsAudioChannels() {
			if (audioInfo) {
				return audioInfo.channels;
			} else {
				return 0;
			}
		}
	});
	Object.defineProperty(self, "ogvjsAudioSampleRate", {
		get: function getOgvJsAudioChannels() {
			if (audioInfo) {
				return audioInfo.rate;
			} else {
				return 0;
			}
		}
	});
	
	// Display size...
	var width = 0, height = 0;
	Object.defineProperty(self, "width", {
		get: function getWidth() {
			return width;
		},
		set: function setWidth(val) {
			width = parseInt(val, 10);
			self.style.width = width + 'px';
		}
	});
	
	Object.defineProperty(self, "height", {
		get: function getHeight() {
			return height;
		},
		set: function setHeight(val) {
			height = parseInt(val, 10);
			self.style.height = height + 'px';
		}
	});

	// Events!

	/**
	 * custom onframecallback, takes frame decode time in ms
	 */
	self.onframecallback = null;
	
	/**
	 * Called when all metadata is available.
	 * Note in theory we must know 'duration' at this point.
	 */
	self.onloadedmetadata = null;
	
	/**
	 * Called when we start playback
	 */
	self.onplay = null;
	
	/**
	 * Called when we get paused
	 */
	self.onpause = null;
	
	/**
	 * Called when playback ends
	 */
	self.onended = null;
	
	return self;
};

OGVPlayer.initSharedAudioContext = function() {
	AudioFeeder.initSharedAudioContext();
};

OGVPlayer.loadingNode = null;
OGVPlayer.loadingCallbacks = [];

OGVPlayer.instanceCount = 0;

function StyleManager() {
	var self = this;
	var el = document.createElement('style');
	el.type = 'text/css';
	el.textContent = 'ogvjs { display: inline-block; position: relative; }';
	document.head.appendChild(el);

	var sheet = el.sheet;

	self.appendRule = function(selector, defs) {
		var bits = [];
		for (prop in defs) {
			if (defs.hasOwnProperty(prop)) {
				bits.push(prop + ':' + defs[prop]);
			}
		}
		var rule = selector + '{' + bits.join(';') + '}';
		sheet.insertRule(rule, sheet.length - 1);
	}
}
OGVPlayer.styleManager = new StyleManager();

OGVPlayer.supportsObjectFit = (typeof document.createElement('div').style.objectFit === 'string');
if (OGVPlayer.supportsObjectFit) {
	OGVPlayer.updatePositionOnResize = function() {
		// no-op
	};
} else {
	OGVPlayer.updatePositionOnResize = function() {
		// IE and Edge don't support object-fit.
		// Also just for fun, IE 10 doesn't support 'auto' sizing on canvas.
		function fixup(el, width, height) {
			var container = el.offsetParent || el.parentNode,
				containerAspect = container.offsetWidth / container.offsetHeight,
				intrinsicAspect = width / height;
			if (intrinsicAspect > containerAspect) {
				var vsize = container.offsetWidth / intrinsicAspect,
					vpad = (container.offsetHeight - vsize) / 2;
				el.style.width = '100%';
				el.style.height = vsize + 'px';
				el.style.marginLeft = 0;
				el.style.marginRight = 0;
				el.style.marginTop = vpad + 'px';
				el.style.marginBottom = vpad + 'px';
			} else {
				var hsize = container.offsetHeight * intrinsicAspect,
					hpad = (container.offsetWidth - hsize) / 2;
				el.style.width = hsize + 'px';
				el.style.height = '100%';
				el.style.marginLeft = hpad + 'px';
				el.style.marginRight = hpad + 'px';
				el.style.marginTop = 0;
				el.style.marginBottom = 0;
			}
		}
		function queryOver(selector, callback) {
			var nodeList = document.querySelectorAll(selector),
				nodeArray = Array.prototype.slice.call(nodeList);
			nodeArray.forEach(callback);
		}

		queryOver('ogvjs > canvas', function(canvas) {
			fixup(canvas, canvas.width, canvas.height);
		});
		queryOver('ogvjs > img', function(poster) {
			fixup(poster, poster.naturalWidth, poster.naturalHeight);
		});
	};
	function fullResizeVideo() {
		// fullscreens may ping us before the resize happens
		setTimeout(OGVPlayer.updatePositionOnResize, 0);
	}

	window.addEventListener('resize', OGVPlayer.updatePositionOnResize);
	window.addEventListener('orientationchange', OGVPlayer.updatePositionOnResize)

	document.addEventListener('fullscreenchange', fullResizeVideo);
	document.addEventListener('mozfullscreenchange', fullResizeVideo);
	document.addEventListener('webkitfullscreenchange', fullResizeVideo);
	document.addEventListener('MSFullscreenChange', fullResizeVideo);
}
