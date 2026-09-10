import React,{useState} from 'react';
import {registerRootComponent} from 'expo';
import {View,Text,Button} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {useFonts} from 'expo-font';
import {Inter_400Regular,Inter_500Medium,Inter_600SemiBold} from '@expo-google-fonts/inter';
import {Sora_600SemiBold,Sora_700Bold} from '@expo-google-fonts/sora';
import {ThemeProvider} from '../../src/context/ThemeContext';
import {ReceiptCamera} from '../../src/components/receipt-camera/ReceiptCamera';
function Preview(){
 const[open,setOpen]=useState(true); const[done,setDone]=useState(0);
 const[ready,fontError]=useFonts({Inter_400Regular,Inter_500Medium,Inter_600SemiBold,Sora_600SemiBold,Sora_700Bold});
 if(!ready)return <View style={{flex:1,justifyContent:'center',padding:32,backgroundColor:'#fff'}}><Text>{fontError ? `Preview fonts failed: ${fontError.message}` : 'Loading preview fonts…'}</Text></View>;
 return <SafeAreaProvider><ThemeProvider initialMode="dark">{open?<ReceiptCamera onCancel={()=>setOpen(false)} onDone={sections=>{setDone(sections.length);setOpen(false);}}/>:<View style={{flex:1,justifyContent:'center',padding:32}}><Text>Approved {done} receipt images. Isolated preview: no upload or expense creation.</Text><Button title="Open scanner" onPress={()=>setOpen(true)}/></View>}</ThemeProvider></SafeAreaProvider>;
}
registerRootComponent(Preview);
