pushd %~dp0


del *.wixobj
candle -out debuglog-fix.wixobj debuglog-fix.wxs

light debuglog-fix.wixobj -sacl -sice:ICE91 -o Morphic-debuglog-fix.msi

popd
