import { expect } from 'chai'
import { desktopCapturer, ipcRenderer, screen, BrowserWindow, SourcesOptions } from 'electron'
import { emittedOnce } from './events-helpers'
import { ifdescribe } from './spec-helpers';
import { closeAllWindows } from './window-helpers';

const features = process.electronBinding('features')

ifdescribe(features.isDesktopCapturerEnabled() && !process.arch.includes('arm') && process.platform !== 'win32')('desktopCapturer', () => {
  let w: BrowserWindow
  before(async () => {
    w = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true } })
    await w.loadURL('about:blank')
  })
  after(closeAllWindows)

  const getSources: typeof desktopCapturer.getSources = (options: SourcesOptions) => {
    return w.webContents.executeJavaScript(`
      require('electron').desktopCapturer.getSources(${JSON.stringify(options)})
    `)
  }

  it('should return a non-empty array of sources', async () => {
    const sources = await getSources({ types: ['window', 'screen'] })
    expect(sources).to.be.an('array').that.is.not.empty()
  })

  it('throws an error for invalid options', async () => {
    const promise = getSources(['window', 'screen'] as any)
    expect(promise).to.be.eventually.rejectedWith(Error, 'Invalid options')
  })

  it('does not throw an error when called more than once (regression)', async () => {
    const sources1 = await getSources({ types: ['window', 'screen'] })
    expect(sources1).to.be.an('array').that.is.not.empty()

    const sources2 = await getSources({ types: ['window', 'screen'] })
    expect(sources2).to.be.an('array').that.is.not.empty()
  })

  it('responds to subsequent calls of different options', async () => {
    const promise1 = getSources({ types: ['window'] })
    expect(promise1).to.not.eventually.be.rejected()

    const promise2 = getSources({ types: ['screen'] })
    expect(promise2).to.not.eventually.be.rejected()
  })

  it('returns an empty display_id for window sources on Windows and Mac', async () => {
    // Linux doesn't return any window sources.
    if (process.platform !== 'win32' && process.platform !== 'darwin') return

    const w = new BrowserWindow({ width: 200, height: 200 })

    const sources = await getSources({ types: ['window'] })
    w.destroy()
    expect(sources).to.be.an('array').that.is.not.empty()
    for (const { display_id: displayId } of sources) {
      expect(displayId).to.be.a('string').and.be.empty()
    }
  })

  it('returns display_ids matching the Screen API on Windows and Mac', async () => {
    if (process.platform !== 'win32' && process.platform !== 'darwin') return

    const displays = screen.getAllDisplays()
    const sources = await getSources({ types: ['screen'] })
    expect(sources).to.be.an('array').of.length(displays.length)

    for (let i = 0; i < sources.length; i++) {
      expect(sources[i].display_id).to.equal(displays[i].id.toString())
    }

    it('returns empty sources when blocked', async () => {
      ipcRenderer.send('handle-next-desktop-capturer-get-sources')
      const sources = await getSources({ types: ['screen'] })
      expect(sources).to.be.empty()
    })
  })

  it('disabling thumbnail should return empty images', async () => {
    const w2 = new BrowserWindow({ show: false, width: 200, height: 200 })
    const wShown = emittedOnce(w2, 'show')
    w2.show()
    await wShown

    const isEmpties: boolean[] = await w.webContents.executeJavaScript(`
      require('electron').desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width: 0, height: 0 }
      }).then((sources) => {
        return sources.map(s => s.thumbnail.constructor.name === 'NativeImage' && s.thumbnail.isEmpty())
      })
    `)

    w2.destroy()
    expect(isEmpties).to.be.an('array').that.is.not.empty()
    expect(isEmpties.every(e => e === true)).to.be.true()
  })

  it('getMediaSourceId should match DesktopCapturerSource.id', async () => {
    const w = new BrowserWindow({ show: false, width: 100, height: 100 })
    const wShown = emittedOnce(w, 'show')
    const wFocused = emittedOnce(w, 'focus')
    w.show()
    w.focus()
    await wShown
    await wFocused

    const mediaSourceId = w.getMediaSourceId()
    const sources = await getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 }
    })
    w.destroy()

    // TODO(julien.isorce): investigate why |sources| is empty on the linux
    // bots while it is not on my workstation, as expected, with and without
    // the --ci parameter.
    if (process.platform === 'linux' && sources.length === 0) {
      it.skip('desktopCapturer.getSources returned an empty source list')
      return
    }

    expect(sources).to.be.an('array').that.is.not.empty()
    const foundSource = sources.find((source) => {
      return source.id === mediaSourceId
    })
    expect(mediaSourceId).to.equal(foundSource!.id)
  })

  it('moveAbove should move the window at the requested place', async () => {
    // DesktopCapturer.getSources() is guaranteed to return in the correct
    // z-order from foreground to background.
    const MAX_WIN = 4
    const mainWindow = w
    const wList = [mainWindow]
    try {
      for (let i = 0; i < MAX_WIN - 1; i++) {
        const w = new BrowserWindow({ show: true, width: 100, height: 100 })
        wList.push(w)
      }
      expect(wList.length).to.equal(MAX_WIN)

      // Show and focus all the windows.
      wList.forEach(async (w) => {
        const wFocused = emittedOnce(w, 'focus')
        w.focus()
        await wFocused
      })
      // At this point our windows should be showing from bottom to top.

      // DesktopCapturer.getSources() returns sources sorted from foreground to
      // background, i.e. top to bottom.
      let sources = await getSources({
        types: ['window'],
        thumbnailSize: { width: 0, height: 0 }
      })

      // TODO(julien.isorce): investigate why |sources| is empty on the linux
      // bots while it is not on my workstation, as expected, with and without
      // the --ci parameter.
      if (process.platform === 'linux' && sources.length === 0) {
        wList.forEach((w) => {
          if (w !== mainWindow) {
            w.destroy()
          }
        })
        it.skip('desktopCapturer.getSources returned an empty source list')
        return
      }

      expect(sources).to.be.an('array').that.is.not.empty()
      expect(sources.length).to.gte(MAX_WIN)

      // Only keep our windows, they must be in the MAX_WIN first windows.
      sources.splice(MAX_WIN, sources.length - MAX_WIN)
      expect(sources.length).to.equal(MAX_WIN)
      expect(sources.length).to.equal(wList.length)

      // Check that the sources and wList are sorted in the reverse order.
      const wListReversed = wList.slice(0).reverse()
      const canGoFurther = sources.every(
        (source, index) => source.id === wListReversed[index].getMediaSourceId())
      if (!canGoFurther) {
        // Skip remaining checks because either focus or window placement are
        // not reliable in the running test environment. So there is no point
        // to go further to test moveAbove as requirements are not met.
        return
      }

      // Do the real work, i.e. move each window above the next one so that
      // wList is sorted from foreground to background.
      wList.forEach(async (w, index) => {
        if (index < (wList.length - 1)) {
          const wNext = wList[index + 1]
          w.moveAbove(wNext.getMediaSourceId())
        }
      })

      sources = await getSources({
        types: ['window'],
        thumbnailSize: { width: 0, height: 0 }
      })
      // Only keep our windows again.
      sources.splice(MAX_WIN, sources.length - MAX_WIN)
      expect(sources.length).to.equal(MAX_WIN)
      expect(sources.length).to.equal(wList.length)

      // Check that the sources and wList are sorted in the same order.
      sources.forEach((source, index) => {
        expect(source.id).to.equal(wList[index].getMediaSourceId())
      })
    } finally {
      wList.forEach((w) => {
        if (w !== mainWindow) {
          w.destroy()
        }
      })
    }
  })
})