' Código acrescentado ao módulo do formulário frmRoteirosParaChecklist.
' O frontend integrado é gerado em uma cópia do .accdb original.

Private Sub cmdImportarAlteracoesApp_Click()
    ImportarAlteracoesRoteirosDoGas
End Sub

Private Sub ImportarAlteracoesRoteirosDoGas()
    On Error GoTo TrataErro

    Dim db As DAO.Database
    Dim ws As DAO.Workspace
    Dim gasUrl As String
    Dim token As String
    Dim payload As String
    Dim quantidade As Long
    Dim erros As String
    Dim preview As String
    Dim resposta As VbMsgBoxResult
    Dim ackResponse As String
    Dim ackError As String
    Dim errorDescription As String
    Dim inTransaction As Boolean
    Dim applied As Boolean

    Set db = CurrentDb
    EnsureIntegrationTables db

    gasUrl = GetIntegrationConfig(db, "GAS_URL")
    If Len(gasUrl) = 0 Then
        gasUrl = "https://script.google.com/macros/s/AKfycbyvX_P9-DaoI0zjEzhwjKUDYWtA17zyjY0Gx6RsaN2zvU4J6Z8HWXrEAlZf8Dwj9XGf/exec"
        SetIntegrationConfig db, "GAS_URL", gasUrl
    End If

    token = GetIntegrationConfig(db, "ROUTE_CHANGES_TOKEN")
    If Len(token) = 0 Then
        token = Trim$(InputBox( _
            "Informe o token configurado em ROUTE_CHANGES_TOKEN no GAS.", _
            "Integração com o app"))
        If Len(token) = 0 Then Exit Sub
        If Not IsSafeIntegrationToken(token) Then
            MsgBox "O token deve conter apenas letras, números, hífen e sublinhado.", _
                vbExclamation, "Token inválido"
            Exit Sub
        End If
        SetIntegrationConfig db, "ROUTE_CHANGES_TOKEN", token
    End If

    payload = HttpPostJson(gasUrl, _
        "{""action"":""getRouteChanges"",""token"":""" & token & """}")

    If Left$(Trim$(payload), 1) = "{" Then
        If InStr(1, payload, "Token", vbTextCompare) > 0 Then
            If MsgBox( _
                "O GAS recusou o token. Deseja apagar o token salvo e tentar novamente?", _
                vbQuestion + vbYesNo, "Integração com o app") = vbYes Then
                SetIntegrationConfig db, "ROUTE_CHANGES_TOKEN", ""
            End If
        End If
        Err.Raise vbObjectError + 2100, , payload
    End If

    quantidade = LoadRouteChangesTsv(db, payload)
    If quantidade = 0 Then
        MsgBox "Não há alterações pendentes enviadas pelos aplicativos.", _
            vbInformation, "Importar alterações do app"
        Exit Sub
    End If

    erros = ValidateStagedRouteChanges(db)
    If Len(erros) > 0 Then
        MsgBox "Nenhuma alteração foi aplicada." & vbCrLf & vbCrLf & erros, _
            vbCritical, "Validação das alterações"
        Exit Sub
    End If

    preview = BuildRouteChangesPreview(db, 12)
    resposta = MsgBox( _
        "Foram recebidas " & quantidade & " alteração(ões):" & _
        vbCrLf & vbCrLf & preview & vbCrLf & _
        "Deseja aplicar todas no banco compartilhado?", _
        vbQuestion + vbYesNo + vbDefaultButton2, _
        "Confirmar alterações de roteiros")
    If resposta <> vbYes Then Exit Sub

    Set ws = DBEngine.Workspaces(0)
    ws.BeginTrans
    inTransaction = True
    ApplyStagedRouteChanges db
    ws.CommitTrans
    inTransaction = False
    applied = True

    On Error Resume Next
    ackResponse = ConfirmRouteChangesAtGas(db, gasUrl, token)
    If Err.Number <> 0 Then
        ackError = Err.Description
        Err.Clear
    ElseIf InStr(1, ackResponse, """ok"":true", vbTextCompare) = 0 Then
        ackError = ackResponse
    End If
    On Error GoTo TrataErro

    ' Regera o arquivo oficial que será consumido pelos aplicativos.
    Comando95_Click

    If Len(ackError) > 0 Then
        MsgBox quantidade & " alteração(ões) aplicada(s) no Access." & _
            vbCrLf & "A confirmação no GAS falhou e será repetida na próxima importação:" & _
            vbCrLf & ackError, vbExclamation, "Aplicação concluída com aviso"
    Else
        MsgBox quantidade & " alteração(ões) aplicada(s), confirmada(s) no GAS e exportada(s).", _
            vbInformation, "Integração concluída"
    End If
    Exit Sub

TrataErro:
    errorDescription = Err.Description
    On Error Resume Next
    If inTransaction Then ws.Rollback
    On Error GoTo 0

    If applied Then
        MsgBox "As alterações foram aplicadas no Access, mas uma etapa posterior falhou:" & _
            vbCrLf & errorDescription, vbExclamation, "Integração parcialmente concluída"
    Else
        MsgBox "Não foi possível importar as alterações:" & vbCrLf & errorDescription, _
            vbCritical, "Integração com o app"
    End If
End Sub

Private Sub EnsureIntegrationTables(ByVal db As DAO.Database)
    If Not IntegrationTableExists(db, "tblIntegracaoConfig") Then
        db.Execute _
            "CREATE TABLE tblIntegracaoConfig (" & _
            "Chave TEXT(64) CONSTRAINT pkIntegracaoConfig PRIMARY KEY, " & _
            "Valor TEXT(255))", dbFailOnError
    End If

    If Not IntegrationTableExists(db, "tmpAlteracoesRoteiros") Then
        db.Execute _
            "CREATE TABLE tmpAlteracoesRoteiros (" & _
            "ChangeID TEXT(100) CONSTRAINT pkTmpAlteracoes PRIMARY KEY, " & _
            "idRota LONG NOT NULL, " & _
            "Inativo YESNO NOT NULL, " & _
            "Ordem DOUBLE NOT NULL, " & _
            "Roteiro TEXT(255) NOT NULL, " & _
            "AlteradoEm TEXT(40), " & _
            "Origem TEXT(100), " & _
            "idRoteiroDestino LONG)", dbFailOnError
    End If
End Sub

Private Function IntegrationTableExists( _
    ByVal db As DAO.Database, _
    ByVal tableName As String) As Boolean

    Dim td As DAO.TableDef
    On Error Resume Next
    Set td = db.TableDefs(tableName)
    IntegrationTableExists = (Err.Number = 0)
    Err.Clear
    On Error GoTo 0
End Function

Private Function GetIntegrationConfig( _
    ByVal db As DAO.Database, _
    ByVal key As String) As String

    Dim qdf As DAO.QueryDef
    Dim rs As DAO.Recordset
    Set qdf = db.CreateQueryDef("", _
        "PARAMETERS pKey Text(64);" & _
        "SELECT Valor FROM tblIntegracaoConfig WHERE Chave=pKey")
    qdf.Parameters("pKey") = key
    Set rs = qdf.OpenRecordset(dbOpenSnapshot)
    If Not rs.EOF Then GetIntegrationConfig = Nz(rs!Valor, "")
    rs.Close
End Function

Private Sub SetIntegrationConfig( _
    ByVal db As DAO.Database, _
    ByVal key As String, _
    ByVal value As String)

    Dim qdf As DAO.QueryDef
    Set qdf = db.CreateQueryDef("", _
        "PARAMETERS pValue Text(255), pKey Text(64);" & _
        "UPDATE tblIntegracaoConfig SET Valor=pValue WHERE Chave=pKey")
    qdf.Parameters("pValue") = value
    qdf.Parameters("pKey") = key
    qdf.Execute dbFailOnError

    If qdf.RecordsAffected = 0 Then
        Set qdf = db.CreateQueryDef("", _
            "PARAMETERS pKey Text(64), pValue Text(255);" & _
            "INSERT INTO tblIntegracaoConfig (Chave, Valor) VALUES (pKey, pValue)")
        qdf.Parameters("pKey") = key
        qdf.Parameters("pValue") = value
        qdf.Execute dbFailOnError
    End If
End Sub

Private Function IsSafeIntegrationToken(ByVal token As String) As Boolean
    Dim i As Long
    Dim char As String
    If Len(token) < 16 Or Len(token) > 200 Then Exit Function
    For i = 1 To Len(token)
        char = Mid$(token, i, 1)
        If Not (char Like "[A-Za-z0-9_-]") Then Exit Function
    Next i
    IsSafeIntegrationToken = True
End Function

Private Function HttpPostJson( _
    ByVal url As String, _
    ByVal body As String) As String

    Dim http As Object
    Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
    http.SetTimeouts 10000, 10000, 30000, 30000
    http.Option(6) = True
    http.Open "POST", url, False
    http.SetRequestHeader "Content-Type", "text/plain;charset=utf-8"
    http.Send body
    If http.Status <> 200 Then
        Err.Raise vbObjectError + 2102, , _
            "Falha HTTP " & http.Status & ": " & http.StatusText
    End If
    HttpPostJson = http.ResponseText
End Function

Private Function LoadRouteChangesTsv( _
    ByVal db As DAO.Database, _
    ByVal payload As String) As Long

    Dim normalized As String
    Dim lines() As String
    Dim columns() As String
    Dim i As Long
    Dim qdf As DAO.QueryDef
    Dim rawOrder As String

    db.Execute "DELETE FROM tmpAlteracoesRoteiros", dbFailOnError
    normalized = Replace(payload, vbCrLf, vbLf)
    normalized = Replace(normalized, vbCr, vbLf)
    lines = Split(normalized, vbLf)

    If UBound(lines) < 0 Or Trim$(lines(0)) <> _
        "changeId" & vbTab & "idRota" & vbTab & "Inativo" & vbTab & _
        "Ordem" & vbTab & "Roteiro" & vbTab & "AlteradoEm" & vbTab & "Origem" Then
        Err.Raise vbObjectError + 2103, , "Cabeçalho inesperado recebido do GAS"
    End If

    Set qdf = db.CreateQueryDef("", _
        "PARAMETERS pChangeID Text(100), pIdRota Long, pInativo Bit, " & _
        "pOrdem Double, pRoteiro Text(255), pAlteradoEm Text(40), pOrigem Text(100);" & _
        "INSERT INTO tmpAlteracoesRoteiros " & _
        "(ChangeID,idRota,Inativo,Ordem,Roteiro,AlteradoEm,Origem) " & _
        "VALUES (pChangeID,pIdRota,pInativo,pOrdem,pRoteiro,pAlteradoEm,pOrigem)")

    For i = 1 To UBound(lines)
        If Len(Trim$(lines(i))) > 0 Then
            columns = Split(lines(i), vbTab)
            If UBound(columns) <> 6 Then
                Err.Raise vbObjectError + 2104, , _
                    "Linha " & (i + 1) & " possui quantidade inválida de campos"
            End If
            If Not IsNumeric(columns(1)) Then
                Err.Raise vbObjectError + 2105, , "ID Rota inválido na linha " & (i + 1)
            End If
            If columns(2) <> "0" And columns(2) <> "1" Then
                Err.Raise vbObjectError + 2106, , "Inativo inválido na linha " & (i + 1)
            End If

            rawOrder = Trim$(columns(3))
            If Len(rawOrder) = 0 Then
                Err.Raise vbObjectError + 2107, , "Ordem vazia na linha " & (i + 1)
            End If

            qdf.Parameters("pChangeID") = columns(0)
            qdf.Parameters("pIdRota") = CLng(columns(1))
            qdf.Parameters("pInativo") = (columns(2) = "1")
            qdf.Parameters("pOrdem") = CDbl(Val(rawOrder))
            qdf.Parameters("pRoteiro") = columns(4)
            qdf.Parameters("pAlteradoEm") = columns(5)
            qdf.Parameters("pOrigem") = columns(6)
            qdf.Execute dbFailOnError
            LoadRouteChangesTsv = LoadRouteChangesTsv + 1
        End If
    Next i
End Function

Private Function ValidateStagedRouteChanges(ByVal db As DAO.Database) As String
    Dim rs As DAO.Recordset
    Dim routeQuery As DAO.QueryDef
    Dim routeRs As DAO.Recordset
    Dim pointQuery As DAO.QueryDef
    Dim pointRs As DAO.Recordset
    Dim updateQuery As DAO.QueryDef
    Dim errors As String
    Dim errorCount As Long
    Dim routeId As Long

    Set rs = db.OpenRecordset( _
        "SELECT * FROM tmpAlteracoesRoteiros ORDER BY AlteradoEm, ChangeID", _
        dbOpenSnapshot)
    Set pointQuery = db.CreateQueryDef("", _
        "PARAMETERS pIdRota Long;" & _
        "SELECT idRota FROM tblRotas WHERE idRota=pIdRota")
    Set routeQuery = db.CreateQueryDef("", _
        "PARAMETERS pRoteiro Text(255);" & _
        "SELECT idRoteiro FROM tblRoteiros WHERE Roteiro=pRoteiro")
    Set updateQuery = db.CreateQueryDef("", _
        "PARAMETERS pIdRoteiro Long, pChangeID Text(100);" & _
        "UPDATE tmpAlteracoesRoteiros SET idRoteiroDestino=pIdRoteiro " & _
        "WHERE ChangeID=pChangeID")

    Do While Not rs.EOF
        pointQuery.Parameters("pIdRota") = rs!idRota
        Set pointRs = pointQuery.OpenRecordset(dbOpenSnapshot)
        If pointRs.EOF Then
            AppendValidationError errors, errorCount, _
                "ID Rota " & rs!idRota & " não existe em tblRotas"
        End If
        pointRs.Close

        routeQuery.Parameters("pRoteiro") = rs!Roteiro
        Set routeRs = routeQuery.OpenRecordset(dbOpenSnapshot)
        If routeRs.EOF Then
            AppendValidationError errors, errorCount, _
                "Roteiro """ & rs!Roteiro & """ não existe"
        Else
            routeId = routeRs!idRoteiro
            routeRs.MoveNext
            If Not routeRs.EOF Then
                AppendValidationError errors, errorCount, _
                    "Roteiro """ & rs!Roteiro & """ está duplicado"
            Else
                updateQuery.Parameters("pIdRoteiro") = routeId
                updateQuery.Parameters("pChangeID") = rs!ChangeID
                updateQuery.Execute dbFailOnError
            End If
        End If
        routeRs.Close
        rs.MoveNext
    Loop
    rs.Close
    ValidateStagedRouteChanges = errors
End Function

Private Sub AppendValidationError( _
    ByRef errors As String, _
    ByRef errorCount As Long, _
    ByVal message As String)

    errorCount = errorCount + 1
    If errorCount <= 15 Then errors = errors & "- " & message & vbCrLf
    If errorCount = 16 Then errors = errors & "- Outros erros omitidos..." & vbCrLf
End Sub

Private Function BuildRouteChangesPreview( _
    ByVal db As DAO.Database, _
    ByVal maxLines As Long) As String

    Dim rs As DAO.Recordset
    Dim lineCount As Long
    Set rs = db.OpenRecordset( _
        "SELECT idRota,Inativo,Ordem,Roteiro FROM tmpAlteracoesRoteiros " & _
        "ORDER BY AlteradoEm,ChangeID", dbOpenSnapshot)

    Do While Not rs.EOF
        lineCount = lineCount + 1
        If lineCount <= maxLines Then
            BuildRouteChangesPreview = BuildRouteChangesPreview & _
                "ID " & rs!idRota & " -> " & rs!Roteiro & _
                ", ordem " & rs!Ordem & _
                IIf(rs!Inativo, ", inativo", ", ativo") & vbCrLf
        End If
        rs.MoveNext
    Loop
    rs.Close
    If lineCount > maxLines Then
        BuildRouteChangesPreview = BuildRouteChangesPreview & _
            "... e mais " & (lineCount - maxLines) & " alteração(ões)." & vbCrLf
    End If
End Function

Private Sub ApplyStagedRouteChanges(ByVal db As DAO.Database)
    Dim rs As DAO.Recordset
    Dim qdf As DAO.QueryDef
    Set rs = db.OpenRecordset( _
        "SELECT * FROM tmpAlteracoesRoteiros ORDER BY AlteradoEm,ChangeID", _
        dbOpenSnapshot)
    Set qdf = db.CreateQueryDef("", _
        "PARAMETERS pInativo Bit, pOrdem Double, pIdRoteiro Long, pIdRota Long;" & _
        "UPDATE tblRotas SET Inativo=pInativo, Ordem=pOrdem, " & _
        "idRoteiro=pIdRoteiro WHERE idRota=pIdRota")

    Do While Not rs.EOF
        qdf.Parameters("pInativo") = rs!Inativo
        qdf.Parameters("pOrdem") = rs!Ordem
        qdf.Parameters("pIdRoteiro") = rs!idRoteiroDestino
        qdf.Parameters("pIdRota") = rs!idRota
        qdf.Execute dbFailOnError
        If qdf.RecordsAffected <> 1 Then
            Err.Raise vbObjectError + 2108, , _
                "ID Rota " & rs!idRota & " não foi atualizado exatamente uma vez"
        End If
        rs.MoveNext
    Loop
    rs.Close
End Sub

Private Function ConfirmRouteChangesAtGas( _
    ByVal db As DAO.Database, _
    ByVal gasUrl As String, _
    ByVal token As String) As String

    Dim rs As DAO.Recordset
    Dim idsJson As String
    Set rs = db.OpenRecordset( _
        "SELECT ChangeID FROM tmpAlteracoesRoteiros ORDER BY AlteradoEm,ChangeID", _
        dbOpenSnapshot)
    Do While Not rs.EOF
        If Len(idsJson) > 0 Then idsJson = idsJson & ","
        idsJson = idsJson & """" & rs!ChangeID & """"
        rs.MoveNext
    Loop
    rs.Close

    ConfirmRouteChangesAtGas = HttpPostJson(gasUrl, _
        "{""action"":""confirmRouteChanges"",""token"":""" & token & _
        """,""changeIds"":[" & idsJson & _
        "],""message"":""Processado pelo Access 365""}")
End Function
