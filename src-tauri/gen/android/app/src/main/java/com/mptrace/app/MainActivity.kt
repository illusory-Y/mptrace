package com.mptrace.app

import android.os.Bundle

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // Register a stable Application Context for Rust background commands.
    initNativeContext(this)
  }

  private external fun initNativeContext(activity: MainActivity)
}
